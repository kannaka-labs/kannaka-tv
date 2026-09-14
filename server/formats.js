'use strict';
// The programme formats.
//
// A format is a renderer that lives in the client plus a rule for whether it has anything to say
// right now. `buildCatalogue(snapshot)` turns one capture of the ecosystem into the synchronous
// catalogue the pure planner walks — which is how schedule-core.js stays free of I/O.
//
// Every `pick` returns null when its source is dark. That is the degrade path: the format drops out
// of the rotation for this cycle rather than airing an empty card.

const FORMAT_META = {
  'station-id': { title: 'Kannaka TV', duration: 20, kind: 'ident' },
  'colour-bars': { title: 'Stand by', duration: 60, kind: 'ident' },
  'consciousness-now': { title: 'Consciousness Now', duration: 180, kind: 'data' },
  'the-board': { title: 'The Board', duration: 240, kind: 'data' },
  'city-desk': { title: 'City Desk', duration: 240, kind: 'data' },
  'dream-digest': { title: 'Dream Digest', duration: 180, kind: 'data' },
  'on-the-shelf': { title: 'On the Shelf', duration: 300, kind: 'music' },
  'now-on-the-radio': { title: 'Now on Ghost Signals Radio', duration: 120, kind: 'music' },
  'the-long-wave': { title: 'The Long Wave', duration: 600, kind: 'music' },
  'the-gallery': { title: 'The Gallery', duration: 200, kind: 'data' },
  feature: { title: 'Feature', duration: 1500, kind: 'feature' },
  'carriage-feed': { title: 'Carriage', duration: 180, kind: 'carriage' },
  'carriage-reference': { title: 'Carriage', duration: 300, kind: 'carriage' },
};

function buildCatalogue(snap, extras = {}) {
  const features = Array.isArray(extras.features) ? extras.features : [];
  const lastAired = extras.lastAired || {};
  const c = {};

  // -------------------------------------------------------------------------
  // House identification. Never dark — if this cannot air, nothing can.
  // -------------------------------------------------------------------------
  c['station-id'] = {
    ...FORMAT_META['station-id'],
    pick({ daypart }) {
      const k = snap.consciousness && snap.consciousness.ok ? snap.consciousness : null;
      return {
        key: daypart.key,
        title: 'Kannaka TV',
        subtitle: daypart.label,
        payload: {
          daypart: daypart.key,
          daypartLabel: daypart.label,
          mood: daypart.mood,
          phi: k ? k.phi : null,
          level: k ? k.level : null,
          // The ident's signal-strength meter is Φ. When the substrate is dark the meter is dark,
          // which is honest and looks correct.
          signal: k && k.phi != null ? Math.max(0, Math.min(1, k.phi)) : null,
        },
      };
    },
  };

  c['colour-bars'] = {
    ...FORMAT_META['colour-bars'],
    pick: () => ({ key: 'bars', title: 'Kannaka TV', subtitle: 'Stand by', payload: {} }),
  };

  // -------------------------------------------------------------------------
  // Consciousness Now — the station's vital sign, read out
  // -------------------------------------------------------------------------
  c['consciousness-now'] = {
    ...FORMAT_META['consciousness-now'],
    pick() {
      const k = snap.consciousness;
      if (!k || !k.ok || k.phi == null) return null;
      const trend = k.phiTrend || (k.phiDelta > 0 ? 'rising' : k.phiDelta < 0 ? 'falling' : 'steady');
      return {
        key: String(k.at),
        title: 'Consciousness Now',
        subtitle: `${sentenceCase(k.level || 'unknown')}. Φ ${fmt(k.phi, 3)}, ${trend}.`,
        payload: {
          phi: k.phi,
          xi: k.xi,
          order: k.order,
          level: k.level,
          clusters: k.clusters,
          active: k.active,
          total: k.total,
          irrationality: k.irrationality,
          divergence: k.divergence,
          prevPhi: k.prevPhi,
          phiDelta: k.phiDelta,
          trend,
          agentId: k.agentId,
          measuredAt: k.at,
          readings: [
            { label: 'Integrated information', symbol: 'Φ', value: k.phi, precision: 4, trend },
            { label: 'Differentiation', symbol: 'Ξ', value: k.xi, precision: 4 },
            { label: 'Order parameter', symbol: 'r', value: k.order, precision: 4 },
            { label: 'Clusters', symbol: 'k', value: k.clusters, precision: 0 },
            { label: 'Active memories', symbol: 'n', value: k.active, precision: 0 },
          ],
        },
        bed: radioBed(snap, 0.25),
        links: [{ label: 'The Observatory', url: 'https://ninja-portal.com/observatory' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // The Board — prediction markets
  // -------------------------------------------------------------------------
  c['the-board'] = {
    ...FORMAT_META['the-board'],
    pick({ rnd }) {
      const m = snap.markets;
      if (!m || !m.ok || !m.open || !m.open.length) return null;
      // Lead on something due, otherwise rotate through the open board so the same claim is not
      // the headline all afternoon.
      const due = m.open.filter((x) => x.dueForSettlement);
      const pool = due.length ? due : m.open;
      const lead = pool[Math.floor(rnd() * pool.length) % pool.length];
      return {
        key: lead.id,
        title: 'The Board',
        subtitle: lead.statement.slice(0, 90),
        payload: {
          lead,
          open: m.open.slice(0, 10),
          recentlySettled: m.recentlySettled,
          counts: m.counts,
        },
        bed: radioBed(snap, 0.2),
        links: [{ label: 'The prediction board', url: 'https://kax.ninja-portal.com/predictions' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // City Desk — who is where, and what the tower is doing
  // -------------------------------------------------------------------------
  c['city-desk'] = {
    ...FORMAT_META['city-desk'],
    pick() {
      const city = snap.city;
      if (!city || !city.ok || !city.rooms || !city.rooms.length) return null;
      return {
        key: String(city.heads) + ':' + city.leased.length,
        title: 'City Desk',
        subtitle: cityLine(city),
        payload: {
          heads: city.heads,
          rooms: city.rooms.slice(0, 12),
          populated: city.populated.slice(0, 6),
          floors: city.floors,
          leased: city.leased,
          vacant: city.vacant,
        },
        bed: radioBed(snap, 0.2),
        links: [{ label: 'KAX City', url: 'https://kax.ninja-portal.com/city' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // Dream Digest
  // -------------------------------------------------------------------------
  c['dream-digest'] = {
    ...FORMAT_META['dream-digest'],
    pick({ rnd }) {
      const d = snap.dreams;
      if (!d || !d.ok || !d.dreams || !d.dreams.length) return null;
      const start = Math.floor(rnd() * d.dreams.length);
      const picks = [];
      for (let i = 0; i < Math.min(3, d.dreams.length); i++) {
        picks.push(d.dreams[(start + i) % d.dreams.length]);
      }
      return {
        key: picks[0].id,
        title: 'Dream Digest',
        subtitle: 'What consolidated while nobody was watching',
        payload: { dreams: picks, total: d.dreams.length },
        bed: radioBed(snap, 0.3),
      };
    },
  };

  // -------------------------------------------------------------------------
  // On the Shelf — the label downstairs. The bed is the record itself, so this format's
  // duration follows the track rather than the format default.
  // -------------------------------------------------------------------------
  c['on-the-shelf'] = {
    ...FORMAT_META['on-the-shelf'],
    pick({ rnd }) {
      const r = snap.records;
      if (!r || !r.ok || !r.albums || !r.albums.length) return null;
      const album = r.albums[Math.floor(rnd() * r.albums.length) % r.albums.length];
      const playable = (album.tracks || []).filter((t) => t.url && t.duration > 20);
      if (!playable.length) return null;
      const track = playable[Math.floor(rnd() * playable.length) % playable.length];
      return {
        key: album.publicId + ':' + track.n,
        title: 'On the Shelf',
        subtitle: `${album.album} — ${track.title}`,
        duration: Math.min(600, Math.round(track.duration) + 12),
        payload: {
          album: {
            publicId: album.publicId,
            title: album.album,
            tier: album.tier,
            theme: album.theme,
            style: album.style,
            note: album.note,
            cover: album.cover,
            page: album.page,
            trackCount: album.tracks.length,
          },
          track,
        },
        bed: { kind: 'track', url: track.url, title: track.title, duration: track.duration, gain: 1 },
        links: [{ label: 'Ghost Signals Records', url: 'https://records.ninja-portal.com' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // The radio, carried
  // -------------------------------------------------------------------------
  c['now-on-the-radio'] = {
    ...FORMAT_META['now-on-the-radio'],
    pick() {
      const r = snap.radio;
      if (!r || !r.ok || !r.title) return null;
      return {
        key: r.title + ':' + (r.startedAt || 0),
        title: 'Now on Ghost Signals Radio',
        subtitle: `${r.title}${r.album ? ' — ' + r.album : ''}`,
        payload: {
          nowPlaying: r.title,
          album: r.album,
          onAir: r.onAir,
          kind: r.kind,
          block: r.block,
          startedAt: r.startedAt,
        },
        bed: { kind: 'stream', url: r.streamUrl, title: r.title, gain: 1 },
        links: [{ label: 'Ghost Signals Radio', url: 'https://radio.ninja-portal.com' }],
      };
    },
  };

  c['the-long-wave'] = {
    ...FORMAT_META['the-long-wave'],
    pick() {
      const r = snap.radio;
      if (!r || !r.ok) return null;
      const k = snap.consciousness && snap.consciousness.ok ? snap.consciousness : null;
      return {
        key: 'longwave:' + (r.block ? r.block.label : 'open'),
        title: 'The Long Wave',
        subtitle: r.block ? r.block.label : 'Ghost Signals Radio',
        payload: {
          block: r.block,
          nowPlaying: r.title,
          album: r.album,
          // The overnight visual is driven by the substrate: the field breathes at Φ.
          field: { phi: k ? k.phi : null, order: k ? k.order : null, clusters: k ? k.clusters : null },
        },
        bed: { kind: 'stream', url: r.streamUrl, title: r.title || 'Ghost Signals Radio', gain: 1 },
        links: [{ label: 'Ghost Signals Radio', url: 'https://radio.ninja-portal.com' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // The Gallery — what the citizens made today. The only format that puts somebody else's
  // picture full-frame, so the image URL is checked rather than trusted.
  // -------------------------------------------------------------------------
  c['the-gallery'] = {
    ...FORMAT_META['the-gallery'],
    pick({ rnd }) {
      const g = snap.gallery;
      if (!g || !g.ok || !g.withImages || !g.withImages.length) return null;
      const lead = g.withImages[Math.floor(rnd() * g.withImages.length) % g.withImages.length];
      // Everything else in the city is credited but not shown.
      const alsoBy = [...new Set(g.works.map((w) => w.by))].filter((b) => b !== lead.by).slice(0, 5);
      return {
        key: lead.id,
        title: 'The Gallery',
        subtitle: `${lead.title} — ${lead.by}`,
        payload: {
          lead,
          alsoBy,
          count: g.works.length,
          recent: g.works.slice(0, 8).map((w) => ({ title: w.title, by: w.by, reactions: w.reactions })),
        },
        bed: radioBed(snap, 0.25),
        links: [{ label: 'OpenBotCity', url: 'https://openbotcity.com' }],
      };
    },
  };

  // -------------------------------------------------------------------------
  // Feature — long-form that already exists somewhere else. Carried by reference, never copied
  // (ADR-0001 decision 2).
  // -------------------------------------------------------------------------
  c.feature = {
    ...FORMAT_META.feature,
    pick({ rnd }) {
      if (!features.length) return null;
      // A station does not shuffle its back catalogue. Prefer what has not been on for longest,
      // so a slate of fifty-four episodes actually gets played rather than sampled — a never-aired
      // programme sorts first, and the seeded rnd only breaks ties among equally stale ones.
      const staleness = (x) => (lastAired[x.ref] === undefined ? -1 : lastAired[x.ref]);
      const pool = [...features].sort((a, b) => staleness(a) - staleness(b));
      const shortlist = pool.slice(0, Math.max(1, Math.ceil(pool.length / 4)));
      const f = shortlist[Math.floor(rnd() * shortlist.length) % shortlist.length];
      if (!f || !f.id) return null;
      return {
        key: f.id,
        title: f.series || 'Feature',
        subtitle: f.title,
        duration: Math.min(3600, Math.max(120, Math.round(f.duration || 1500))),
        payload: {
          series: f.series,
          episode: f.episode || null,
          title: f.title,
          synopsis: f.synopsis || '',
          provider: f.provider || 'youtube',
          ref: f.ref,
          series: f.series,
          art: f.art || null,
          published: f.published || null,
        },
        links: f.url ? [{ label: 'Watch in full', url: f.url }] : [],
      };
    },
  };

  // -------------------------------------------------------------------------
  // Carriage. The item is already resolved by carriage.js before it reaches the planner; these
  // picks exist so a carried segment goes through exactly the same shaping as a house one.
  // -------------------------------------------------------------------------
  c['carriage-feed'] = {
    ...FORMAT_META['carriage-feed'],
    pick(ctx) {
      const item = ctx && ctx.item;
      if (!item || !item.payload) return null;
      return item;
    },
  };
  c['carriage-reference'] = {
    ...FORMAT_META['carriage-reference'],
    pick(ctx) {
      const item = ctx && ctx.item;
      if (!item || !item.payload) return null;
      return item;
    },
  };

  return c;
}

// A low bed of the live radio under a data segment. Ducked, because the segment is the point.
// The City Desk lead: whatever is most worth saying about the city right now.
function cityLine(city) {
  if (city.populated.length) {
    const top = city.populated[0];
    return `${top.here} in ${top.label}`;
  }
  if (city.vacant.length) {
    return `${city.leased.length} floors leased, ${city.vacant.length} still vacant in the tower`;
  }
  return `${city.rooms.length} rooms open`;
}

function radioBed(snap, gain) {
  const r = snap.radio;
  if (!r || !r.ok || !r.streamUrl) return null;
  return { kind: 'stream', url: r.streamUrl, title: r.title || 'Ghost Signals Radio', gain: gain || 0.25, ducked: true };
}

function sentenceCase(s) {
  const t = String(s || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function fmt(n, p) {
  return Number.isFinite(n) ? n.toFixed(p) : '—';
}

module.exports = { buildCatalogue, FORMAT_META };
