'use strict';
// The transmitter: it owns the clock, keeps the schedule, and records what went out.
//
// The schedule lives in memory and is rebuilt forward on a timer. It is append-only — a rebuild
// extends the horizon and never touches a segment that has started (ADR-0001 decision 6). The air
// log is the durable record and is keyed on segment id, which is never reused.

const db = require('./db');
const config = require('./config');
const sources = require('./sources');
const { buildCatalogue, FORMAT_META } = require('./formats');
const sc = require('./schedule-core');
const carriage = require('./carriage');
const core = require('./carriage-core');
const webhooks = require('./webhooks');
const features = require('./features');

const state = {
  schedule: [],
  planState: null,
  builtAt: 0,
  snapshotAt: 0,
  lastError: null,
  rebuilds: 0,
  logged: new Set(), // segment ids already written to the air log, so the sweep is cheap
  catalogue: null, // the latest catalogue, kept so a data segment can be re-read at transmission
  feedPayloads: {},
};

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

async function rebuild() {
  const t = now();
  try {
    const [snap, grants, feedPayloads, aired] = await Promise.all([
      sources.snapshot(),
      carriage.listGrants('active'),
      carriage.payloads(),
      carriage.airedToday(t),
    ]);

    // Least-recently-aired programming wins the slot. Without this a 54-feature slate still
    // repeats one episode while others never run, because each slot picks independently.
    const lastAired = await lastAiredByRef();
    const catalogue = buildCatalogue(snap, { features: features.list(), lastAired });

    // Carriage eligibility is resolved per daypart, so work out which daypart the horizon we are
    // about to plan actually falls in. Planning rarely spans more than two, and the planner
    // re-checks the daypart per segment anyway; this only decides who is in the queue.
    const planFrom = state.schedule.length
      ? state.schedule[state.schedule.length - 1].startsAt + state.schedule[state.schedule.length - 1].duration * 1000
      : t;
    const daypartKey = sc.daypartAt(planFrom).key;
    const eligible = core.eligible({
      grants,
      daypartKey,
      airedToday: aired,
      payloads: feedPayloads,
    });

    const until = t + config.horizonMinutes * 60 * 1000;
    const { segments, state: nextState } = sc.extend({
      existing: state.schedule,
      from: t,
      until,
      catalogue,
      carriage: eligible,
      state: state.planState,
    });

    state.schedule = state.schedule.concat(segments);
    state.planState = nextState;
    state.catalogue = catalogue;
    state.feedPayloads = feedPayloads;
    state.builtAt = t;
    state.snapshotAt = snap.at;
    state.rebuilds++;
    state.lastError = null;

    prune(t);
    await logTransmitted(t);
    return { added: segments.length, total: state.schedule.length };
  } catch (e) {
    // A failed rebuild must not take the channel off air — the existing schedule keeps playing and
    // we try again on the next tick.
    state.lastError = { at: t, message: String((e && e.message) || e) };
    return { added: 0, total: state.schedule.length, error: state.lastError.message };
  }
}

/** ref -> the most recent time it went out. Read from the air log, which is the durable record. */
async function lastAiredByRef() {
  try {
    const rows = await db.all(
      'SELECT ref, MAX(starts_at) AS last FROM airlog WHERE ref IS NOT NULL GROUP BY ref'
    );
    const out = {};
    for (const r of rows) out[r.ref] = r.last;
    return out;
  } catch {
    return {}; // never let a scheduling nicety break the transmitter
  }
}

function prune(t) {
  const cutoff = t - config.keepPastMinutes * 60 * 1000;
  let i = 0;
  while (i < state.schedule.length) {
    const s = state.schedule[i];
    if (s.startsAt + s.duration * 1000 >= cutoff) break;
    state.logged.delete(s.id);
    i++;
  }
  if (i > 0) state.schedule = state.schedule.slice(i);
}

// ---------------------------------------------------------------------------
// The air log — written on transmission, not on planning
// ---------------------------------------------------------------------------

async function logTransmitted(t) {
  const due = state.schedule.filter((s) => s.startsAt <= t && !state.logged.has(s.id));
  for (const s of due) {
    try {
      const res = await db.run(
        `INSERT OR IGNORE INTO airlog
           (segment_id, format_id, title, subtitle, daypart, grant_id, principal, starts_at, duration, logged_at, ref)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          s.id,
          s.formatId,
          s.title,
          s.subtitle || '',
          s.daypart,
          s.carriage ? s.carriage.grantId : null,
          s.carriage ? s.carriage.principal : null,
          s.startsAt,
          s.duration,
          new Date().toISOString(),
          (s.payload && (s.payload.ref || (s.payload.album && s.payload.album.publicId))) || null,
        ]
      );
      state.logged.add(s.id);
      // Only report an airing we actually recorded. An IGNOREd insert means it was already logged
      // — reporting again would tell a partner they aired twice.
      if (res.changes > 0 && s.carriage) {
        await webhooks.enqueueAirReport(s);
      }
    } catch (e) {
      // Leave it unlogged; the next sweep retries.
      state.lastError = { at: t, message: 'airlog: ' + String((e && e.message) || e) };
    }
  }
}

// ---------------------------------------------------------------------------
// Replanning the tail
//
// "Append only" protects what has been TRANSMITTED or ANNOUNCED — it must not mean the rundown can
// never change. With a six-hour horizon and append-only rebuilds, a carriage partner approved at
// noon would first air at six in the evening, which makes carriage useless. A real station
// rewrites the back half of the rundown all the time; what it never does is move something that is
// on air or about to be.
//
// So a programming change drops every segment that starts more than `graceMinutes` from now and
// plans that stretch again. Anything on air, and anything a viewer has already been shown as
// coming next, is untouched.
// ---------------------------------------------------------------------------

const REPLAN_GRACE_MS = 15 * 60 * 1000;

async function replanTail(reason) {
  const t = now();
  const cut = t + REPLAN_GRACE_MS;
  const kept = state.schedule.filter((s) => s.startsAt < cut);
  if (kept.length === state.schedule.length) return { dropped: 0, reason };

  const dropped = state.schedule.length - kept.length;
  state.schedule = kept;
  state.planState = stateAfter(kept);
  const r = await rebuild();
  return { dropped, added: r.added, reason };
}

// Rebuild the planner's cursor state to match a truncated schedule, so the rotation and the
// identification clock carry on from the last segment we kept rather than from wherever the old
// tail had reached.
function stateAfter(kept) {
  if (!kept.length) return { rotationIndex: 0, lastStationIdAt: 0, lastDaypart: null, carriageIndex: 0 };
  const last = kept[kept.length - 1];
  const lastIdent = [...kept].reverse().find((s) => s.formatId === 'station-id');
  const dp = sc.DAYPARTS.find((d) => d.key === last.daypart);
  let rotationIndex = 0;
  if (dp) {
    const idx = dp.rotation.indexOf(last.formatId);
    if (idx >= 0) rotationIndex = idx + 1;
  }
  return {
    rotationIndex,
    lastStationIdAt: lastIdent ? lastIdent.startsAt : 0,
    lastDaypart: last.daypart,
    carriageIndex: state.planState ? state.planState.carriageIndex | 0 : 0,
  };
}

// ---------------------------------------------------------------------------
// Live payloads at transmission
//
// The horizon is six hours; a snapshot is two minutes old at most. If a segment aired the payload
// it was PLANNED with, a market card at 22:00 would show the odds from 16:00 and the ADR's promise
// that "a market card shows the odds as of transmission" would be a lie.
//
// So the schedule commits to the STRUCTURE — when, which format, how long, which id — and a data
// segment re-reads its payload from the current catalogue as it goes out. Nothing that a viewer or
// the guide has already been told can move: not the id, not the start, not the duration.
//
// Only `data` formats are re-read. A record or a feature IS its content; re-picking one mid-
// programme would change what you are watching while you watch it.
// ---------------------------------------------------------------------------

function resolveLive(segment) {
  if (!segment) return segment;

  // A carried segment follows its own feed clock — take whatever the refresher last cached.
  if (segment.carriage) {
    const fresh = state.feedPayloads[segment.carriage.grantId];
    return fresh ? { ...segment, payload: fresh } : segment;
  }

  const meta = FORMAT_META[segment.formatId];
  if (!meta || meta.kind !== 'data') return segment;

  const fmt = state.catalogue && state.catalogue[segment.formatId];
  if (!fmt || !fmt.pick) return segment;

  try {
    const rnd = sc.mulberry32(sc.seedFor(segment.startsAt, segment.formatId));
    const item = fmt.pick({ cursor: segment.startsAt, daypart: sc.daypartAt(segment.startsAt), rnd });
    if (!item || !item.payload) return segment; // the source went dark since planning; keep what we have
    return {
      ...segment,
      subtitle: item.subtitle || segment.subtitle,
      payload: item.payload,
      bed: item.bed || segment.bed,
      links: item.links || segment.links,
      live: true,
    };
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Reading the broadcast
// ---------------------------------------------------------------------------

function onAir(at) {
  const t = at || now();
  const on = sc.nowOn(state.schedule, t);
  if (!on) return null;
  return { ...on, serverNow: t };
}

function nowPayload(at) {
  const t = at || now();
  const on = sc.nowOn(state.schedule, t);
  if (!on) {
    return {
      ok: false,
      reason: state.schedule.length ? 'outside_schedule' : 'not_built',
      serverNow: t,
    };
  }
  const next = sc.upcoming(state.schedule, t, 3);
  return {
    ok: true,
    serverNow: t,
    daypart: { key: on.segment.daypart, label: on.segment.daypartLabel },
    now: publicSegment(resolveLive(on.segment), { offset: on.offset, remaining: on.remaining }),
    // What is coming is announced with its planned payload. It has not been transmitted yet, and
    // the guide should not promise data it will re-read anyway.
    next: next.map((s) => publicSegment(s, { planned: true })),
  };
}

// The agent track. Same object the browser renders from — one schedule, two tracks
// (ADR-0001, the two-track broadcast).
function publicSegment(s, extra = {}) {
  return {
    id: s.id,
    format: s.formatId,
    title: s.title,
    subtitle: s.subtitle || '',
    startsAt: s.startsAt,
    endsAt: s.startsAt + s.duration * 1000,
    duration: s.duration,
    daypart: s.daypart,
    payload: s.payload || {},
    bed: s.bed || null,
    links: s.links || [],
    carriage: s.carriage || null,
    // True when the payload was re-read at transmission rather than served as planned. An agent
    // reading the broadcast needs to know which it got.
    live: s.live === true,
    ...extra,
  };
}

// The guide announces the running order. It deliberately carries NO payload: a data segment
// re-reads its numbers at transmission, so publishing them hours ahead would be publishing figures
// we already know we will replace. It also keeps the response small enough for a one-core box —
// with payloads a three-hour guide was 197 KB.
function guide(at, hours) {
  const t = at || now();
  const until = t + (hours || 3) * 3600 * 1000;
  return state.schedule
    .filter((s) => s.startsAt + s.duration * 1000 > t && s.startsAt < until)
    .map((s) => ({
      id: s.id,
      format: s.formatId,
      title: s.title,
      subtitle: s.subtitle || '',
      startsAt: s.startsAt,
      endsAt: s.startsAt + s.duration * 1000,
      duration: s.duration,
      daypart: s.daypart,
      carriage: s.carriage || null,
    }));
}

function segmentById(id) {
  const s = state.schedule.find((x) => x.id === id);
  if (!s) return null;
  // A segment that is on air now is served live; one still to come is served as planned.
  const t = now();
  const airing = s.startsAt <= t && t < s.startsAt + s.duration * 1000;
  return publicSegment(airing ? resolveLive(s) : s, airing ? {} : { planned: true });
}

function status() {
  const t = now();
  const on = sc.nowOn(state.schedule, t);
  const last = state.schedule.length ? state.schedule[state.schedule.length - 1] : null;
  return {
    onAir: Boolean(on),
    segments: state.schedule.length,
    horizonEndsAt: last ? last.startsAt + last.duration * 1000 : null,
    horizonSeconds: last ? Math.round((last.startsAt + last.duration * 1000 - t) / 1000) : 0,
    builtAt: state.builtAt,
    snapshotAt: state.snapshotAt,
    rebuilds: state.rebuilds,
    lastError: state.lastError,
    serverNow: t,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let timer = null;
let feedTimer = null;

async function start() {
  await rebuild();
  timer = setInterval(() => {
    rebuild().catch(() => {});
  }, Math.max(15, config.rebuildSeconds) * 1000);
  timer.unref?.();

  // Feeds refresh on their own clock so a slow partner never delays a rebuild.
  const refresh = () => carriage.refreshAll().catch(() => {});
  refresh();
  feedTimer = setInterval(refresh, Math.max(60, config.feed.refreshSeconds) * 1000);
  feedTimer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  if (feedTimer) clearInterval(feedTimer);
  timer = null;
  feedTimer = null;
}

module.exports = { rebuild, replanTail, stateAfter, lastAiredByRef, REPLAN_GRACE_MS, start, stop, onAir, nowPayload, guide, segmentById, status, publicSegment, resolveLive, state };
