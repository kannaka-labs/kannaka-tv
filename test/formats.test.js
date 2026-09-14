'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildCatalogue, FORMAT_META } = require('../server/formats');
const sc = require('../server/schedule-core');

const DAYPART = sc.DAYPARTS.find((d) => d.key === 'prime');
const ctx = (seed) => ({ cursor: 1789317000000, daypart: DAYPART, rnd: sc.mulberry32(seed || 1) });

const LIVE = {
  consciousness: { ok: true, phi: 0.7, xi: 0.1, order: 0.14, level: 'integrated', clusters: 30, active: 1075, total: 1075, phiTrend: 'rising', phiDelta: 0.07, at: 1789317000000 },
  markets: { ok: true, counts: { all: 9, open: 7, settled: 2 }, open: [{ id: 'm1', statement: 'A thing happens', settlesBy: '2026-09-20', dueForSettlement: false }], recentlySettled: [] },
  radio: { ok: true, title: 'A Song', album: 'An Album', streamUrl: 'https://radio.ninja-portal.com/stream', block: { label: 'Morning', mood: 'bright', albums: [] }, onAir: true },
  records: { ok: true, albums: [{ publicId: 'p1', album: 'Night One', tier: 'EP', theme: 't', style: 's', cover: 'https://records.ninja-portal.com/c.png', page: 'https://records.ninja-portal.com/album/p1', tracks: [{ n: 1, title: 'Opening', duration: 197.2, url: 'https://records.ninja-portal.com/1.mp3' }] }] },
  city: { ok: true, rooms: [{ id: 'city', label: 'The street', here: 2 }], populated: [{ id: 'city', label: 'The street', here: 2 }], heads: 2, floors: [{ floorNo: 2, status: 'leased', label: 'GSA' }], leased: [{ floorNo: 2 }], vacant: [4, 5] },
  dreams: { ok: true, dreams: [{ id: 'd1', content: 'A long enough dream sentence to survive the filter', ageHours: 12, layer: 0, terms: [] }] },
  gallery: {
    ok: true,
    works: [{ id: 'g1', title: 'The Open Frame', by: 'The Archivist', about: 'a figure', reactions: 1 }],
    withImages: [{ id: 'g1', title: 'The Open Frame', by: 'The Archivist', about: 'a figure', image: 'https://example.com/a.png' }],
  },
};

const DARK = { ok: false, reason: 'unreachable' };
const ALL_DARK = { consciousness: DARK, markets: DARK, radio: DARK, records: DARK, city: DARK, dreams: DARK, gallery: DARK };

test('every format named in a daypart rotation exists in the catalogue', () => {
  const cat = buildCatalogue(LIVE, { features: [] });
  for (const d of sc.DAYPARTS) {
    for (const f of d.rotation) assert.ok(cat[f], `${d.key} rotates a format the catalogue lacks: ${f}`);
  }
  assert.ok(cat['colour-bars'], 'the fallback format must always exist');
});

test('every catalogue entry has metadata and a kind', () => {
  const cat = buildCatalogue(LIVE, { features: [] });
  for (const id of Object.keys(cat)) {
    assert.ok(FORMAT_META[id], `${id} has no metadata`);
    assert.ok(FORMAT_META[id].kind, `${id} has no kind`);
    assert.ok(FORMAT_META[id].duration > 0, `${id} has no duration`);
  }
});

test('with live sources, every house format has something to say', () => {
  const cat = buildCatalogue(LIVE, { features: [{ id: 'f1', title: 'A Feature', ref: 'abcdefghijk', provider: 'youtube', duration: 900 }], music: [{ id: 'm1', track: 'A Track', album: 'AN ALBUM', ref: 'bbcdefghijk', provider: 'youtube', duration: 240 }] });
  for (const id of ['station-id', 'consciousness-now', 'the-board', 'city-desk', 'dream-digest', 'on-the-shelf', 'now-on-the-radio', 'the-long-wave', 'the-gallery', 'feature', 'music-video']) {
    const item = cat[id].pick(ctx());
    assert.ok(item, `${id} refused to air with live data`);
    assert.ok(item.title, `${id} produced no title`);
  }
});

test('with every source dark, only the house idents can air', () => {
  const cat = buildCatalogue(ALL_DARK, { features: [] });
  assert.ok(cat['station-id'].pick(ctx()), 'the station must always be able to identify itself');
  assert.ok(cat['colour-bars'].pick(ctx()), 'the test card must always be available');
  for (const id of ['consciousness-now', 'the-board', 'city-desk', 'dream-digest', 'on-the-shelf', 'now-on-the-radio', 'the-long-wave', 'the-gallery']) {
    assert.strictEqual(cat[id].pick(ctx()), null, `${id} aired on a dark source`);
  }
});

test('a format whose own source is dark returns null even when others are live', () => {
  const cat = buildCatalogue({ ...LIVE, records: DARK, markets: DARK }, { features: [] });
  assert.strictEqual(cat['on-the-shelf'].pick(ctx()), null);
  assert.strictEqual(cat['the-board'].pick(ctx()), null);
  assert.ok(cat['city-desk'].pick(ctx()), 'an unrelated format was taken down with them');
});

test('an album with no playable track does not air', () => {
  const noTracks = { ...LIVE, records: { ok: true, albums: [{ publicId: 'p', album: 'A', tracks: [{ n: 1, title: 't', duration: 4, url: null }] }] } };
  assert.strictEqual(buildCatalogue(noTracks, {}).pick === undefined, true);
  assert.strictEqual(buildCatalogue(noTracks, {})['on-the-shelf'].pick(ctx()), null);
});

test('On the Shelf takes its duration from the record, not the format default', () => {
  const item = buildCatalogue(LIVE, {})['on-the-shelf'].pick(ctx());
  assert.strictEqual(item.duration, Math.round(197.2) + 12);
  assert.strictEqual(item.bed.kind, 'track');
  assert.strictEqual(item.bed.url, 'https://records.ninja-portal.com/1.mp3');
});

test('a data segment beds the radio quietly and ducked; a music segment does not', () => {
  const cat = buildCatalogue(LIVE, {});
  const data = cat['consciousness-now'].pick(ctx());
  assert.strictEqual(data.bed.ducked, true);
  assert.ok(data.bed.gain < 0.5, 'the bed would drown the segment');

  const music = cat['now-on-the-radio'].pick(ctx());
  assert.strictEqual(music.bed.gain, 1);
  assert.ok(!music.bed.ducked);
});

test('the ident carries the signal reading, and shows none when the substrate is dark', () => {
  assert.strictEqual(buildCatalogue(LIVE, {})['station-id'].pick(ctx()).payload.signal, 0.7);
  assert.strictEqual(buildCatalogue(ALL_DARK, {})['station-id'].pick(ctx()).payload.signal, null);
});

test('The Board leads on a claim that is due when one is', () => {
  const withDue = {
    ...LIVE,
    markets: {
      ok: true,
      counts: { all: 2, open: 2, settled: 0 },
      open: [
        { id: 'later', statement: 'Not due', settlesBy: '2026-12-01', dueForSettlement: false },
        { id: 'due', statement: 'Due today', settlesBy: '2026-09-13', dueForSettlement: true },
      ],
      recentlySettled: [],
    },
  };
  for (let seed = 1; seed < 12; seed++) {
    const item = buildCatalogue(withDue, {})['the-board'].pick(ctx(seed));
    assert.strictEqual(item.payload.lead.id, 'due', `seed ${seed} led on a claim that is not due`);
  }
});

test('The Board rotates its lead across slots rather than repeating one all afternoon', () => {
  const many = {
    ...LIVE,
    markets: {
      ok: true,
      counts: { all: 6, open: 6, settled: 0 },
      open: Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, statement: 'Claim ' + i, settlesBy: '2026-12-01', dueForSettlement: false })),
      recentlySettled: [],
    },
  };
  const cat = buildCatalogue(many, {});
  const leads = new Set();
  for (let seed = 1; seed < 30; seed++) leads.add(cat['the-board'].pick(ctx(seed)).payload.lead.id);
  assert.ok(leads.size > 2, `the lead barely moved: ${leads.size} distinct claims across 29 slots`);
});

test('a format subtitle does not use the joined-middle-dot house style', () => {
  const cat = buildCatalogue(LIVE, { features: [{ id: 'f', title: 'T', ref: 'abcdefghijk', provider: 'youtube' }] });
  for (const id of Object.keys(cat)) {
    const item = cat[id].pick({ ...ctx(), item: { payload: { headline: 'x' }, title: 'x' } });
    if (!item || !item.subtitle) continue;
    assert.ok(!/ · /.test(item.subtitle), `${id} subtitle joins with middle dots: ${item.subtitle}`);
  }
});

test('a carriage format only airs when an item is handed to it', () => {
  const cat = buildCatalogue(LIVE, {});
  assert.strictEqual(cat['carriage-feed'].pick(ctx()), null, 'carriage aired with nothing to carry');
  const item = { payload: { headline: 'h' }, title: 'Partner', duration: 120 };
  assert.strictEqual(cat['carriage-feed'].pick({ ...ctx(), item }), item);
});

test('picking is deterministic for a given seed', () => {
  const cat = buildCatalogue(LIVE, {});
  for (const id of ['the-board', 'dream-digest', 'on-the-shelf']) {
    assert.deepStrictEqual(cat[id].pick(ctx(7)), cat[id].pick(ctx(7)), `${id} is not deterministic`);
  }
});

// ---------------------------------------------------------------- the slate

test('the feature picker prefers what has not been on for longest', () => {
  // With 54 features and two Prime slots a cycle, independent random picks repeat some episodes
  // and never reach others. The air log is what stops that.
  const feats = Array.from({ length: 12 }, (_, i) => ({
    id: 'f' + i, title: 'Ep ' + i, ref: 'r' + i, provider: 'youtube', duration: 900, series: 'S',
  }));
  const lastAired = {};
  feats.slice(0, 10).forEach((f, i) => (lastAired[f.ref] = 1_000 + i)); // r0..r9 aired; r10,r11 never

  const cat = buildCatalogue(LIVE, { features: feats, lastAired });
  const picked = new Set();
  for (let seed = 1; seed < 40; seed++) picked.add(cat.feature.pick(ctx(seed)).payload.ref);

  assert.ok(picked.has('r10') && picked.has('r11'), 'a never-aired programme was never chosen');
  assert.ok(!picked.has('r9'), 'the most recently aired programme was chosen again');
});

test('with nothing aired yet every feature is reachable', () => {
  const feats = Array.from({ length: 8 }, (_, i) => ({
    id: 'f' + i, title: 'Ep ' + i, ref: 'r' + i, provider: 'youtube', duration: 900, series: 'S',
  }));
  const cat = buildCatalogue(LIVE, { features: feats, lastAired: {} });
  const picked = new Set();
  for (let seed = 1; seed < 60; seed++) picked.add(cat.feature.pick(ctx(seed)).payload.ref);
  assert.ok(picked.size > 1, 'a cold slate collapsed onto one programme');
});

test('a feature carries its ref, so the air log can record WHICH programme aired', () => {
  const cat = buildCatalogue(LIVE, {
    features: [{ id: 'f', title: 'T', ref: 'abcdefghijk', provider: 'youtube', duration: 900, series: 'Ghost Signals' }],
  });
  const item = cat.feature.pick(ctx(3));
  assert.strictEqual(item.payload.ref, 'abcdefghijk');
  assert.strictEqual(item.payload.series, 'Ghost Signals');
});

test('the published slate is public-only and excludes the retired episode', () => {
  const slate = require('../data/features.json');
  assert.ok(slate.length > 40, `expected the full back catalogue, got ${slate.length}`);
  for (const f of slate) {
    assert.ok(/^[A-Za-z0-9_-]{11}$/.test(f.ref), `${f.id} has a malformed YouTube ref: ${f.ref}`);
    assert.ok(f.duration > 0, `${f.id} has no duration`);
    assert.ok(f.series, `${f.id} has no series`);
  }
  // GSP-007 was permanently retired from the station and must not return through the slate.
  assert.ok(!slate.some((f) => f.episode === 'GSP-007'), 'the retired episode is being carried');
  const refs = slate.map((f) => f.ref);
  assert.strictEqual(new Set(refs).size, refs.length, 'the slate carries a duplicate video');
});

test('a music video brings its own sound, so it carries no radio bed', () => {
  // The client pauses the audio bed whenever it embeds; a bed here would be two tracks at once.
  const cat = buildCatalogue(LIVE, {
    music: [{ id: 'm', track: 'Small Rooms', album: 'WHAT PERSISTED', ref: 'abcdefghijk', provider: 'youtube', duration: 250 }],
  });
  const item = cat['music-video'].pick(ctx(1));
  assert.ok(item, 'the music slate did not air');
  assert.ok(!item.bed, 'a music video was given a radio bed');
  assert.strictEqual(item.payload.ref, 'abcdefghijk');
  assert.strictEqual(item.title, 'WHAT PERSISTED');
  assert.strictEqual(item.subtitle, 'Small Rooms');
});

test('an empty music slate drops the format out of the rotation', () => {
  assert.strictEqual(buildCatalogue(LIVE, { music: [] })['music-video'].pick(ctx(1)), null);
  assert.strictEqual(buildCatalogue(LIVE, {})['music-video'].pick(ctx(1)), null);
});

test('the music slate is public refs only and never overlaps the feature slate', () => {
  const music = require('../data/music.json');
  const features = require('../data/features.json');
  const carried = new Set(features.map((f) => f.ref));
  assert.ok(music.length > 20, `expected the music catalogue, got ${music.length}`);
  for (const m of music) {
    assert.ok(/^[A-Za-z0-9_-]{11}$/.test(m.ref), `${m.id} has a malformed ref: ${m.ref}`);
    assert.ok(m.track, `${m.id} has no track name`);
    assert.ok(m.duration > 0 && m.duration <= 9 * 60, `${m.id} is not short-form: ${m.duration}s`);
    assert.ok(!carried.has(m.ref), `${m.ref} is carried as BOTH a feature and a music video`);
  }
  const refs = music.map((m) => m.ref);
  assert.strictEqual(new Set(refs).size, refs.length, 'the music slate carries a duplicate video');
});

test('both slates skip what the pass has already booked (the real chooser, not a fixture)', () => {
  // schedule.test.js covers this with its own hand-written pick(); this one exercises the
  // chooser that actually ships, for both slates, so the two cannot drift apart.
  const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ id: p + i, ref: (p + i).padEnd(11, 'x'), title: 'T' + i, track: 'T' + i, duration: 300 }));
  const features = mk(8, 'f');
  const music = mk(8, 'm');
  const cat = buildCatalogue(LIVE, { features, music, lastAired: {} });

  for (const [fmt, slate] of [['feature', features], ['music-video', music]]) {
    // Book everything except one; the chooser must return the one left.
    const recent = slate.slice(0, slate.length - 1).map((x) => x.ref);
    const only = slate[slate.length - 1].ref;
    for (let seed = 1; seed < 12; seed++) {
      const item = cat[fmt].pick({ ...ctx(seed), recent });
      assert.strictEqual(item.payload.ref, only, `${fmt} booked something already in recent (seed ${seed})`);
    }
  }
});

test('when everything is booked a slate still airs rather than going dark', () => {
  const slate = [{ id: 'a', ref: 'aaaaaaaaaaa', title: 'A', track: 'A', duration: 300 }];
  const cat = buildCatalogue(LIVE, { features: slate, music: slate, lastAired: {} });
  for (const fmt of ['feature', 'music-video']) {
    const item = cat[fmt].pick({ ...ctx(1), recent: ['aaaaaaaaaaa'] });
    assert.ok(item, `${fmt} went dark when its whole slate was already booked`);
    assert.strictEqual(item.payload.ref, 'aaaaaaaaaaa');
  }
});
