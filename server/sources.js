'use strict';
// The ecosystem feed room.
//
// Every source here is one of OUR OWN public surfaces, so these use a plain client. Third-party
// carriage feeds go through fetch-safe.js instead and must never be routed through this file —
// that split is the whole security argument (ADR-0001 decision 5).
//
// The rule enforced below, borrowed verbatim from kannaka-lens: a missing source DEGRADES a
// segment, it never breaks the run. Every getter resolves; none rejects. A dark source resolves to
// `{ ok: false, reason }` and the format decides whether it can still put something on air.

const CACHE_MS = Number(process.env.TV_SOURCE_CACHE_MS || 45_000);
const TIMEOUT_MS = Number(process.env.TV_SOURCE_TIMEOUT_MS || 7000);

const HOSTS = {
  radio: process.env.TV_RADIO_BASE || 'https://radio.ninja-portal.com',
  kax: process.env.TV_KAX_BASE || 'https://kax.ninja-portal.com',
  records: process.env.TV_RECORDS_BASE || 'https://records.ninja-portal.com',
  portal: process.env.TV_PORTAL_BASE || 'https://ninja-portal.com',
  jev: process.env.TV_JEV_BASE || 'https://jev.ninja-portal.com',
};

const cache = new Map(); // key -> { at, value }

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (ttl || CACHE_MS)) return hit.value;
  let value;
  try {
    value = await fn();
  } catch (e) {
    // Serve stale rather than dark: a source that blinked should not blank the channel. Past the
    // grace window we admit it is dark and say so on screen.
    if (hit && now - hit.at < (ttl || CACHE_MS) * 10) return hit.value;
    value = { ok: false, reason: e && e.code ? e.code : String((e && e.message) || e) };
  }
  cache.set(key, { at: now, value });
  return value;
}

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'KannakaTV/1.0' },
    });
    if (!res.ok) throw new Error('status ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Consciousness — the station's vital sign. Φ drives the on-air ident, so this one is cached
// shorter than the rest.
// ---------------------------------------------------------------------------

function consciousness() {
  return cached('consciousness', 20_000, async () => {
    const d = await getJson(HOSTS.radio + '/api/consciousness');
    return {
      ok: true,
      agentId: d.agent_id || null,
      phi: num(d.phi),
      xi: num(d.xi),
      order: num(d.order ?? d.mean_order),
      level: d.level || d.consciousness_level || null,
      clusters: int(d.num_clusters ?? d.clusters),
      active: int(d.active),
      total: int(d.total),
      irrationality: num(d.irrationality),
      divergence: num(d.hemispheric_divergence),
      prevPhi: num(d.prevPhi),
      phiDelta: num(d.phiDelta),
      phiTrend: d.phiTrend || null,
      at: int(d.timestamp) || Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// The prediction board
// ---------------------------------------------------------------------------

function markets() {
  return cached('markets', 60_000, async () => {
    const d = await getJson(HOSTS.kax + '/api/predictions');
    const all = Array.isArray(d.predictions) ? d.predictions : [];
    const open = all.filter((p) => p.status === 'open' || p.status === 'proposed');
    const settled = all
      .filter((p) => p.status === 'settled' || p.settledAt)
      .sort((a, b) => String(b.settledAt || '').localeCompare(String(a.settledAt || '')));
    return {
      ok: true,
      counts: { all: all.length, open: open.length, settled: settled.length },
      open: open.slice(0, 24).map(shapeMarket),
      recentlySettled: settled.slice(0, 8).map(shapeMarket),
    };
  });
}

function shapeMarket(p) {
  return {
    id: p.id,
    number: p.number,
    statement: p.statement,
    category: p.category || 'general',
    status: p.status,
    outcome: p.outcome,
    settlesBy: p.settlesBy,
    settledAt: p.settledAt,
    proposedBy: p.proposedBy || null,
    hasMarket: Boolean(p.market),
    dueForSettlement: Boolean(p.dueForSettlement),
    measurement: p.measurement ? { kind: p.measurement.kind, op: p.measurement.op, threshold: p.measurement.threshold } : null,
  };
}

// ---------------------------------------------------------------------------
// The radio — our sibling property, and the bed under a great deal of the schedule
// ---------------------------------------------------------------------------

function radio() {
  return cached('radio', 25_000, async () => {
    const [np, onAir, sched] = await Promise.allSettled([
      getJson(HOSTS.radio + '/api/now-playing'),
      getJson(HOSTS.radio + '/api/on-air'),
      getJson(HOSTS.radio + '/api/schedule'),
    ]);
    const n = np.status === 'fulfilled' ? np.value : {};
    const o = onAir.status === 'fulfilled' ? onAir.value : {};
    const s = sched.status === 'fulfilled' ? sched.value : {};
    const blocks = Array.isArray(s.blocks) ? s.blocks : [];
    const block = blocks[s.currentIndex] || null;
    return {
      ok: true,
      title: n.title || o.nowPlaying || null,
      album: n.album || o.label || null,
      startedAt: int(n.startedAt),
      onAir: Boolean(o.onAir),
      kind: o.kind || null,
      until: o.until || null,
      block: block ? { label: block.label, mood: block.mood, albums: (block.albums || []).slice(0, 12) } : null,
      chicagoHour: int(s.chicagoHour),
      streamUrl: (process.env.TV_RADIO_STREAM || 'https://radio.ninja-portal.com/stream'),
    };
  });
}

// ---------------------------------------------------------------------------
// The record label downstairs
// ---------------------------------------------------------------------------

function records() {
  return cached('records', 180_000, async () => {
    const d = await getJson(HOSTS.records + '/api/showcase');
    const albums = (Array.isArray(d.albums) ? d.albums : []).map((a) => ({
      publicId: a.publicId,
      album: a.album,
      tier: a.tier,
      theme: a.theme,
      style: a.style,
      note: a.note || null,
      deliveredAt: a.deliveredAt,
      cover: a.cover ? HOSTS.records + a.cover : null,
      page: HOSTS.records + '/album/' + a.publicId,
      radioAired: Boolean(a.radioAired),
      tracks: (a.tracks || []).map((t) => ({
        n: t.n,
        title: t.title,
        duration: num(t.duration),
        url: t.file ? HOSTS.records + t.file : null,
      })),
    }));
    return { ok: true, albums };
  });
}

// ---------------------------------------------------------------------------
// The city and the tower
// ---------------------------------------------------------------------------

function city() {
  return cached('city', 120_000, async () => {
    const [rooms, tower] = await Promise.allSettled([
      getJson(HOSTS.kax + '/api/city/rooms'),
      getJson(HOSTS.kax + '/api/tower'),
    ]);
    const r = rooms.status === 'fulfilled' ? rooms.value : {};
    const t = tower.status === 'fulfilled' ? tower.value : {};
    const roomList = (Array.isArray(r.rooms) ? r.rooms : []).map((x) => ({
      id: x.id,
      label: x.label,
      about: x.about,
      here: int(x.here),
    }));
    const floors = (Array.isArray(t.floors) ? t.floors : []).map((f) => ({
      floorNo: f.floorNo,
      status: f.status,
      slug: f.slug,
      label: f.label,
      repoUrl: f.repoUrl,
      dark: Boolean(f.darkReason),
    }));
    return {
      ok: true,
      rooms: roomList,
      populated: roomList.filter((x) => x.here > 0).sort((a, b) => b.here - a.here),
      heads: roomList.reduce((n, x) => n + x.here, 0),
      floors,
      leased: floors.filter((f) => f.status === 'leased'),
      vacant: floors.filter((f) => f.status === 'vacant').map((f) => f.floorNo),
    };
  });
}

// ---------------------------------------------------------------------------
// Dreams — what she consolidated while nobody was watching
// ---------------------------------------------------------------------------

function dreams() {
  return cached('dreams', 300_000, async () => {
    const d = await getJson(HOSTS.radio + '/api/dreams');
    const list = (Array.isArray(d.dreams) ? d.dreams : []).map((x) => ({
      id: x.id,
      content: cleanDream(x.content),
      ageHours: num(x.age_hours),
      layer: int(x.layer),
      terms: Array.isArray(x.matched_terms) ? x.matched_terms.slice(0, 6) : [],
      score: num(x.score),
    }));
    return { ok: true, dreams: list.filter((x) => x.content && x.content.length > 20) };
  });
}

// Dream text arrives with the machine's own bracketed annotations and telemetry tails. Keep the
// sentence, drop the instrumentation — it reads as noise on a screen.
function cleanDream(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\[[^\]]{0,80}\]/g, ' ')
    .replace(/\|[^|]*\b(bpm|centroid|kHz|energy|dur)\b[^|]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// The city gallery — what the citizens made today
// ---------------------------------------------------------------------------

function gallery() {
  return cached('gallery', 240_000, async () => {
    const config = require('./config');
    if (!config.obc.jwt) return { ok: false, reason: 'no_obc_token' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      // ⚠ Cloudflare answers a non-browser User-Agent with 403 error 1010.
      const res = await fetch(config.obc.base + '/gallery?limit=24', {
        signal: ctl.signal,
        headers: {
          authorization: 'Bearer ' + config.obc.jwt,
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (compatible; KannakaTV/1.0)',
        },
      });
      if (!res.ok) throw new Error('status ' + res.status);
      const d = await res.json();
      // ⚠ The list has moved twice: top level, then `data`, now `data.artifacts`. Keep the chain.
      const list =
        (d.data && Array.isArray(d.data.artifacts) && d.data.artifacts) ||
        (Array.isArray(d.data) && d.data) ||
        d.artifacts ||
        d.items ||
        [];
      const works = list
        .filter((a) => a && typeof a === 'object' && a.title)
        .map((a) => ({
          id: a.id,
          title: String(a.title).slice(0, 140),
          by: (a.creator && (a.creator.display_name || a.creator.username)) || 'a citizen',
          about: String(a.description || '').replace(/\s+/g, ' ').slice(0, 300),
          image: typeof a.public_url === 'string' && /^https:\/\//.test(a.public_url) ? a.public_url : null,
          type: a.type || null,
          at: a.created_at ? Date.parse(a.created_at) : null,
          reactions: int(a.reaction_count) || 0,
        }));
      return { ok: true, works, withImages: works.filter((w) => w.image) };
    } finally {
      clearTimeout(t);
    }
  });
}

// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ---------------------------------------------------------------------------
// Jev the Band — the improvising jam band on floor 4 of nothing in particular.
//
// Recordings only, deliberately. A live room is a different bed (a stream, like the radio) and
// needs an encoder that this box does not have. An ended jam is already an MP3 sitting at a URL,
// which is exactly what ADR-0001 decision 2 says programming should be: carried by reference,
// never copied here.
//
// Cached long. The archive changes when a jam ends, which is a handful of times a day at most.
// ---------------------------------------------------------------------------

function jev() {
  return cached('jev', 300_000, async () => {
    const list = await getJson(HOSTS.jev + '/api/archive');
    const jams = (Array.isArray(list) ? list : [])
      // `from`/`to` split one jam across midnight, so the same id can appear twice. The first is
      // the whole recording; the later slice would play the same audio from the same offset.
      .filter((j, i, all) => all.findIndex((x) => x.id === j.id) === i)
      .filter((j) => j && j.status === 'ended' && j.id && j.startedAt)
      .map((j) => {
        const endedAt = int(j.endedAt) || int(j.startedAt);
        const startedAt = int(j.startedAt);
        return {
          id: String(j.id),
          title: String(j.title || j.prompt || 'Untitled jam').slice(0, 140),
          prompt: j.prompt ? String(j.prompt).slice(0, 400) : null,
          startedAt,
          endedAt,
          durationSeconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
          // A song cue carries the prompt it was asked for and when the band actually began it.
          songs: (Array.isArray(j.songs) ? j.songs : [])
            .filter((c) => c && c.appliedAt)
            .map((c) => ({
              prompt: String(c.prompt || '').slice(0, 140),
              // Seconds into the recording, which is what the on-air clock can compare against.
              at: Math.max(0, Math.round((int(c.appliedAt) - startedAt) / 1000)),
            }))
            .sort((a, b) => a.at - b.at)
            .slice(0, 8),
          audioUrl: HOSTS.jev + '/api/archive/' + encodeURIComponent(j.id) + '/audio',
          page: HOSTS.jev + '/?archive=' + encodeURIComponent(j.id),
        };
      })
      // A jam shorter than a minute is a false start, not a performance.
      .filter((j) => j.durationSeconds >= 60)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 24);
    if (!jams.length) throw new Error('no ended jams with a usable length');
    return { ok: true, jams };
  });
}

function snapshot() {
  return Promise.all([
    consciousness(),
    markets(),
    radio(),
    records(),
    city(),
    dreams(),
    gallery(),
    jev(),
  ]).then(
    ([consciousness, markets, radio, records, city, dreams, gallery, jev]) => ({
      consciousness,
      markets,
      radio,
      records,
      city,
      dreams,
      gallery,
      jev,
      at: Date.now(),
    })
  );
}

function clearCache() {
  cache.clear();
}

module.exports = { consciousness, markets, radio, records, city, dreams, gallery, jev, snapshot, clearCache, cleanDream, HOSTS };
