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
};

const DARK = { ok: false, reason: 'unreachable' };
const ALL_DARK = { consciousness: DARK, markets: DARK, radio: DARK, records: DARK, city: DARK, dreams: DARK };

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
  const cat = buildCatalogue(LIVE, { features: [{ id: 'f1', title: 'A Feature', ref: 'abcdefghijk', provider: 'youtube', duration: 900 }] });
  for (const id of ['station-id', 'consciousness-now', 'the-board', 'city-desk', 'dream-digest', 'on-the-shelf', 'now-on-the-radio', 'the-long-wave', 'feature']) {
    const item = cat[id].pick(ctx());
    assert.ok(item, `${id} refused to air with live data`);
    assert.ok(item.title, `${id} produced no title`);
  }
});

test('with every source dark, only the house idents can air', () => {
  const cat = buildCatalogue(ALL_DARK, { features: [] });
  assert.ok(cat['station-id'].pick(ctx()), 'the station must always be able to identify itself');
  assert.ok(cat['colour-bars'].pick(ctx()), 'the test card must always be available');
  for (const id of ['consciousness-now', 'the-board', 'city-desk', 'dream-digest', 'on-the-shelf', 'now-on-the-radio', 'the-long-wave']) {
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
