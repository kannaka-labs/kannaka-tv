'use strict';
// The broadcast clock and the programme planner.
//
// PURE. No I/O, no Date.now(), no unseeded randomness. Everything that varies is an argument.
// This is the one authority for what is on air, for both the human track and the agent track
// (ADR-0001 decision 1). If you find yourself wanting to read the network here, you want sources.js.

// ---------------------------------------------------------------------------
// Dayparts (ADR-0001 decision 7). Hours are America/Chicago, matching the radio's own
// daypart clock so the two properties agree about what time it is.
// ---------------------------------------------------------------------------

const DAYPARTS = [
  {
    key: 'long-wave',
    label: 'The Long Wave',
    start: 0,
    end: 6,
    mood: 'contemplative',
    rotation: ['the-long-wave', 'music-video', 'consciousness-now', 'dream-digest', 'music-video', 'the-long-wave', 'on-the-shelf'],
    carriageEvery: 5,
  },
  {
    key: 'morning-report',
    label: 'Morning Report',
    start: 6,
    end: 10,
    mood: 'briefing',
    rotation: ['dream-digest', 'the-board', 'consciousness-now', 'music-video', 'city-desk', 'now-on-the-radio'],
    carriageEvery: 4,
  },
  {
    key: 'the-board',
    label: 'The Board',
    start: 10,
    end: 14,
    mood: 'trading',
    rotation: ['the-board', 'city-desk', 'the-board', 'consciousness-now', 'now-on-the-radio'],
    carriageEvery: 3,
  },
  {
    key: 'city-desk',
    label: 'City Desk',
    start: 14,
    end: 18,
    mood: 'streetlevel',
    rotation: ['city-desk', 'the-gallery', 'on-the-shelf', 'the-board', 'city-desk', 'now-on-the-radio'],
    carriageEvery: 3,
  },
  {
    key: 'prime',
    label: 'Prime',
    start: 18,
    end: 22,
    mood: 'feature',
    rotation: ['feature', 'on-the-shelf', 'the-gallery', 'city-desk', 'feature', 'consciousness-now'],
    carriageEvery: 4,
  },
  {
    key: 'late-signal',
    label: 'Late Signal',
    start: 22,
    end: 24,
    mood: 'strange',
    rotation: ['consciousness-now', 'music-video', 'the-gallery', 'dream-digest', 'the-long-wave', 'music-video', 'on-the-shelf'],
    carriageEvery: 4,
  },
];

const STATION_ID = 'station-id';
// A station identification airs when the daypart turns over, and never more than this far apart.
const STATION_ID_INTERVAL_S = 15 * 60;
// How many recently-scheduled programmes a planning pass remembers, so it does not book one
// twice in an evening. Long enough to cover a daypart's worth of feature slots.
const RECENT_MEMORY = 16;

// ---------------------------------------------------------------------------
// Chicago wall-clock hour without pulling in a timezone library.
// Intl is in every Node 20 build we run on; if it ever is not, we degrade to UTC rather than throw,
// because a broadcaster that stops transmitting over a timezone is a bad broadcaster.
// ---------------------------------------------------------------------------

function chicagoHour(ms) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(ms));
    const h = Number(s);
    // Intl renders midnight as "24" in some ICU versions.
    return Number.isFinite(h) ? h % 24 : new Date(ms).getUTCHours();
  } catch {
    return new Date(ms).getUTCHours();
  }
}

function daypartAt(ms) {
  const h = chicagoHour(ms);
  for (const d of DAYPARTS) if (h >= d.start && h < d.end) return d;
  return DAYPARTS[0];
}

// ---------------------------------------------------------------------------
// Seeded PRNG. The plan for a given second must be the same plan every time we compute it, or
// "rebuilding never moves what is on air" is a hope rather than a property.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(ms, salt) {
  let h = 2166136261 >>> 0;
  const s = String(ms) + '|' + String(salt || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Segment ids. Stable for a given (startsAt, format, pick) so a replan is idempotent, and never
// reused across different content — the air log is keyed on this (ADR-0001 decision 6).
// ---------------------------------------------------------------------------

function segmentId(startsAt, formatId, discriminator) {
  const seed = seedFor(startsAt, formatId + '|' + (discriminator == null ? '' : String(discriminator)));
  return (
    's' +
    Math.floor(startsAt / 1000).toString(36) +
    '-' +
    formatId.replace(/[^a-z0-9]+/gi, '').slice(0, 6).toLowerCase() +
    '-' +
    seed.toString(36).padStart(7, '0').slice(0, 7)
  );
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Plan the next segment at `cursor`.
 *
 * @param {object} o
 * @param {number} o.cursor            ms, when this segment starts
 * @param {object} o.state             { rotationIndex, lastStationIdAt, lastDaypart, aired: {formatId: count} }
 * @param {object} o.catalogue         formatId -> { duration, pick(ctx) -> item|null }  (see formats.js)
 * @param {Array}  o.carriage          eligible carriage items, highest priority first
 * @returns {{segment: object, state: object}}
 */
function planOne({ cursor, state, catalogue, carriage }) {
  const dp = daypartAt(cursor);
  const st = {
    rotationIndex: state.rotationIndex | 0,
    lastStationIdAt: state.lastStationIdAt || 0,
    lastDaypart: state.lastDaypart || null,
    carriageIndex: state.carriageIndex | 0,
    // What this pass has already scheduled, newest first. The air log only knows what has
    // TRANSMITTED, so without this a single planning pass happily books the same programme
    // three times in one hour — it did, before this existed.
    recent: Array.isArray(state.recent) ? state.recent : [],
  };

  // 1. Station identification — on a daypart turn, or when we have not identified in a while.
  const daypartTurned = st.lastDaypart !== null && st.lastDaypart !== dp.key;
  const overdue = cursor - st.lastStationIdAt >= STATION_ID_INTERVAL_S * 1000;
  if (daypartTurned || overdue || st.lastDaypart === null) {
    const seg = makeSegment({ cursor, formatId: STATION_ID, dp, catalogue, item: null });
    if (seg) {
      return {
        segment: seg,
        state: { ...st, lastStationIdAt: cursor, lastDaypart: dp.key },
      };
    }
    // station-id is a house format with no external dependency; if it is missing we carry on
    // rather than stall the transmitter.
  }

  // 2. Carriage gets the slot when its turn comes up and something is waiting.
  const carriageTurn = dp.carriageEvery > 0 && st.rotationIndex % dp.carriageEvery === 0;
  if (carriageTurn && carriage && carriage.length) {
    const item = carriage[st.carriageIndex % carriage.length];
    const seg = makeSegment({
      cursor,
      formatId: item.formatId,
      dp,
      catalogue,
      item,
      carriage: item,
    });
    if (seg) {
      return {
        segment: seg,
        state: {
          ...st,
          rotationIndex: st.rotationIndex + 1,
          carriageIndex: st.carriageIndex + 1,
          lastDaypart: dp.key,
        },
      };
    }
  }

  // 3. House rotation. Walk the daypart's rotation, skipping formats with nothing to say right now
  //    — a format whose source is dark degrades out of the rotation, it does not air empty.
  const rot = dp.rotation;
  for (let step = 0; step < rot.length; step++) {
    const idx = (st.rotationIndex + step) % rot.length;
    const formatId = rot[idx];
    const fmt = catalogue[formatId];
    if (!fmt) continue;
    const rnd = mulberry32(seedFor(cursor, formatId));
    const item = fmt.pick ? fmt.pick({ cursor, daypart: dp, rnd, recent: st.recent }) : {};
    if (!item) continue;
    const seg = makeSegment({ cursor, formatId, dp, catalogue, item });
    if (!seg) continue;
    const ref = seg.payload && seg.payload.ref;
    return {
      segment: seg,
      state: {
        ...st,
        rotationIndex: idx + 1,
        lastDaypart: dp.key,
        recent: ref ? [ref, ...st.recent].slice(0, RECENT_MEMORY) : st.recent,
      },
    };
  }

  // 4. Nothing in the rotation can air. The channel does not go silent: it falls back to the
  //    house card, which is always available (ADR-0001 decision 5 — degrade, never break).
  const seg = makeSegment({ cursor, formatId: 'colour-bars', dp, catalogue, item: null }) || {
    id: segmentId(cursor, 'colour-bars', 'fallback'),
    formatId: 'colour-bars',
    title: 'Kannaka TV',
    subtitle: 'Stand by',
    startsAt: cursor,
    duration: 60,
    daypart: dp.key,
    daypartLabel: dp.label,
    payload: {},
    bed: null,
    carriage: null,
  };
  return { segment: seg, state: { ...st, rotationIndex: st.rotationIndex + 1, lastDaypart: dp.key } };
}

function makeSegment({ cursor, formatId, dp, catalogue, item, carriage }) {
  const fmt = catalogue[formatId];
  if (!fmt) return null;
  const resolved = item === null || item === undefined ? (fmt.pick ? fmt.pick({ cursor, daypart: dp, rnd: mulberry32(seedFor(cursor, formatId)) }) : {}) : item;
  if (!resolved) return null;

  const duration = clampDuration(resolved.duration || fmt.duration || 120);
  return {
    id: segmentId(cursor, formatId, resolved.key || resolved.id || ''),
    formatId,
    title: resolved.title || fmt.title || formatId,
    subtitle: resolved.subtitle || '',
    startsAt: cursor,
    duration,
    endsAt: cursor + duration * 1000,
    daypart: dp.key,
    daypartLabel: dp.label,
    payload: resolved.payload || {},
    bed: resolved.bed || null,
    links: resolved.links || [],
    carriage: carriage
      ? { principal: carriage.principal, label: carriage.label, grantId: carriage.grantId }
      : null,
  };
}

function clampDuration(d) {
  const n = Math.round(Number(d) || 0);
  if (!Number.isFinite(n) || n < 5) return 5;
  if (n > 60 * 60) return 60 * 60; // an hour is the longest single programme
  return n;
}

/**
 * Extend a schedule up to `until`, appending only.
 *
 * Never touches an existing segment. `existing` is whatever is already committed; planning resumes
 * from the end of it. This is the whole of ADR-0001 decision 6.
 */
function extend({ existing, until, catalogue, carriage, state, from }) {
  const out = [];
  let st = state || { rotationIndex: 0, lastStationIdAt: 0, lastDaypart: null, carriageIndex: 0 };
  const last = existing && existing.length ? existing[existing.length - 1] : null;
  let cursor = last ? last.startsAt + last.duration * 1000 : from;
  if (!Number.isFinite(cursor)) throw new Error('extend needs `from` when `existing` is empty');

  let guard = 0;
  while (cursor < until) {
    if (++guard > 5000) break; // a planner that cannot advance must not spin the box
    const { segment, state: next } = planOne({ cursor, state: st, catalogue, carriage });
    out.push(segment);
    st = next;
    cursor = segment.startsAt + segment.duration * 1000;
  }
  return { segments: out, state: st, cursor };
}

/**
 * What is on at `now`, and where we are inside it.
 * Returns null when `now` is outside the schedule entirely — the caller decides whether that means
 * "not built yet" or "off air".
 */
function nowOn(schedule, now) {
  if (!schedule || !schedule.length) return null;
  // Schedules are ordered and contiguous; binary search rather than scan, because the guide keeps
  // hours of segments and /api/now is the hottest route on the box.
  let lo = 0;
  let hi = schedule.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = schedule[mid];
    const end = s.startsAt + s.duration * 1000;
    if (now < s.startsAt) hi = mid - 1;
    else if (now >= end) lo = mid + 1;
    else
      return {
        segment: s,
        offset: Math.max(0, Math.round((now - s.startsAt) / 1000)),
        remaining: Math.max(0, Math.round((end - now) / 1000)),
        index: mid,
      };
  }
  return null;
}

function upcoming(schedule, now, count) {
  const n = nowOn(schedule, now);
  const start = n ? n.index + 1 : schedule.findIndex((s) => s.startsAt >= now);
  if (start < 0) return [];
  return schedule.slice(start, start + (count || 5));
}

module.exports = {
  DAYPARTS,
  STATION_ID,
  STATION_ID_INTERVAL_S,
  RECENT_MEMORY,
  chicagoHour,
  daypartAt,
  mulberry32,
  seedFor,
  segmentId,
  planOne,
  extend,
  nowOn,
  upcoming,
  clampDuration,
};
