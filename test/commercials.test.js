'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../server/schedule-core');
const { buildCatalogue, FORMAT_META } = require('../server/formats');
const slate = require('../scripts/build-slate');

// Commercials (ADR-0001 decision 3a). A break is a bumper between programmes: one or two spots,
// never a block, breaks twenty minutes apart, labelled as a commercial, listed in the guide.
//
// The planner rule has three clauses and each test below is the one a mutant of that clause fails:
// drop the gap and the hour fills with breaks; drop the per-break cap and spots run back to back;
// drop the strict second pick and one spot airs twice in a row.

const T0 = Date.UTC(2026, 9, 19, 16, 0, 0); // 11:00 Chicago, The Board
const HOUR = 3600 * 1000;

const SPOT = (ref, over = {}) => ({
  id: ref,
  title: 'Spot ' + ref,
  sponsor: null,
  provider: 'youtube',
  ref,
  url: 'https://www.youtube.com/watch?v=' + ref,
  duration: 49,
  published: '2026-10-19',
  ...over,
});
const SPOTS = [SPOT('aaaaaaaaaaa'), SPOT('bbbbbbbbbbb'), SPOT('ccccccccccc', { duration: 16 })];

// A tiny catalogue so these tests exercise the break rule, not the live formats: one programme
// format that always has something, the ident, and the commercial format from formats.js.
function catalogue(commercials = SPOTS) {
  const mk = (id, duration) => ({ title: id, duration, kind: 'data', pick: () => ({ key: id, title: id, payload: { ref: 'prog-' + id } }) });
  const c = {
    'station-id': { title: 'Kannaka TV', duration: 20, kind: 'ident', pick: ({ daypart }) => ({ key: daypart.key, title: 'Kannaka TV', payload: {} }) },
    'colour-bars': { title: 'Stand by', duration: 60, kind: 'ident', pick: () => ({ key: 'bars', title: 'Stand by', payload: {} }) },
  };
  for (const d of sc.DAYPARTS) for (const f of d.rotation) if (!c[f]) c[f] = mk(f, 240);
  const dark = { consciousness: { ok: false }, markets: { ok: false }, radio: { ok: false }, records: { ok: false }, city: { ok: false }, dreams: { ok: false }, gallery: { ok: false }, at: 0 };
  c.commercial = buildCatalogue(dark, { commercials }).commercial;
  return c;
}

const plan = (hours, commercials) =>
  sc.extend({ existing: [], from: T0, until: T0 + hours * HOUR, catalogue: catalogue(commercials), carriage: [] }).segments;

const breaksIn = (segments) => {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].formatId !== 'commercial') continue;
    if (i === 0 || segments[i - 1].formatId !== 'commercial') out.push({ at: segments[i].startsAt, spots: [segments[i]] });
    else out[out.length - 1].spots.push(segments[i]);
  }
  return out;
};

test('the commercial format has metadata, is its own content, and is in no daypart rotation', () => {
  assert.ok(FORMAT_META.commercial, 'no metadata');
  assert.strictEqual(FORMAT_META.commercial.kind, 'feature', 'a spot is its content: never re-read at transmission');
  for (const d of sc.DAYPARTS) assert.ok(!d.rotation.includes('commercial'), `${d.key} books spots in its rotation`);
});

test('a break airs only between programmes and never splits one', () => {
  const segs = plan(3);
  assert.ok(segs.some((s) => s.formatId === 'commercial'), 'no spot aired in three hours');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (i) assert.strictEqual(s.startsAt, segs[i - 1].startsAt + segs[i - 1].duration * 1000, 'the schedule is contiguous');
    if (s.formatId !== 'commercial') continue;
    const prev = segs[i - 1];
    assert.ok(prev, 'a spot cannot open the schedule');
    // The programme before the break ran its whole planned length: the break did not cut it.
    assert.ok(prev.duration >= 20, `the spot at ${i} cut ${prev.formatId} to ${prev.duration}s`);
  }
});

test('a break is one or two spots, never a block', () => {
  // The literal, not the constant: a mutant that raises the cap must fail here.
  assert.strictEqual(sc.COMMERCIAL_SPOTS_PER_BREAK, 2);
  for (const b of breaksIn(plan(6))) assert.ok(b.spots.length >= 1 && b.spots.length <= 2, `a break of ${b.spots.length}`);
});

test('breaks are at least twenty minutes apart, so an hour carries at most three', () => {
  const breaks = breaksIn(plan(6));
  assert.ok(breaks.length >= 6, `only ${breaks.length} breaks in six hours`);
  for (let i = 1; i < breaks.length; i++) {
    assert.ok(breaks[i].at - breaks[i - 1].at >= sc.COMMERCIAL_BREAK_GAP_S * 1000, 'two breaks closer than the gap');
  }
  for (let h = 0; h < 6; h++) {
    const n = breaks.filter((b) => b.at >= T0 + h * HOUR && b.at < T0 + (h + 1) * HOUR).length;
    assert.ok(n <= 3, `${n} breaks in hour ${h}`);
    const spots = breaksIn(plan(6)).flatMap((b) => b.spots).filter((s) => s.startsAt >= T0 + h * HOUR && s.startsAt < T0 + (h + 1) * HOUR);
    assert.ok(spots.length <= 6, `${spots.length} spots in hour ${h}`);
  }
});

test('the second spot of a break is a different spot', () => {
  for (const b of breaksIn(plan(6))) {
    if (b.spots.length < 2) continue;
    assert.notStrictEqual(b.spots[0].payload.ref, b.spots[1].payload.ref, 'a spot aired twice in a row');
  }
});

test('with one spot in the slate a break is one spot long, and the spot still airs', () => {
  const breaks = breaksIn(plan(3, [SPOT('aaaaaaaaaaa')]));
  assert.ok(breaks.length >= 3, `only ${breaks.length} breaks`);
  for (const b of breaks) assert.strictEqual(b.spots.length, 1, 'one spot cannot make a two-spot break');
});

test('no spots in the slate means no breaks and no holes', () => {
  const segs = plan(2, []);
  assert.strictEqual(segs.filter((s) => s.formatId === 'commercial').length, 0);
  for (let i = 1; i < segs.length; i++) assert.strictEqual(segs[i].startsAt, segs[i - 1].startsAt + segs[i - 1].duration * 1000);
});

test('a spot is labelled, carries its ref, its own length, and no bed', () => {
  const seg = plan(2).find((s) => s.formatId === 'commercial');
  assert.strictEqual(seg.title, 'Commercial');
  assert.ok(SPOTS.some((s) => s.ref === seg.payload.ref), 'the ref is one of the slate');
  assert.strictEqual(seg.payload.commercial, true);
  assert.strictEqual(seg.duration, SPOTS.find((s) => s.ref === seg.payload.ref).duration);
  assert.strictEqual(seg.bed, null);
});

test('planning with spots is deterministic', () => {
  assert.deepStrictEqual(plan(3), plan(3));
});

test('the planner state carries the break clock through a replan', () => {
  // transmitter.stateAfter rebuilds the clock from a kept tail; a tail ending mid-break must
  // continue that break, not open a new one, and must remember the gap.
  const transmitter = require('../server/transmitter');
  const segs = plan(2);
  const firstSpot = segs.findIndex((s) => s.formatId === 'commercial');
  const kept = segs.slice(0, firstSpot + 1);
  const st = transmitter.stateAfter(kept);
  assert.strictEqual(st.lastFormatId, 'commercial');
  assert.strictEqual(st.breakSpots, 1);
  assert.strictEqual(st.lastCommercialAt, segs[firstSpot].startsAt);
  assert.deepStrictEqual(st.recentSpots, [segs[firstSpot].payload.ref]);
  // Continuing from that state: the next segment may be the second spot, but a third never follows.
  const next = sc.extend({ existing: kept, until: kept[kept.length - 1].startsAt + HOUR, catalogue: catalogue(), carriage: [], state: st }).segments;
  const run = [kept[kept.length - 1], ...next];
  for (const b of breaksIn(run)) assert.ok(b.spots.length <= 2);
});

// ---------------------------------------------------------------- the slate builder

const CAT = [
  { playlist: 'Commercials', playlistId: slate.COMMERCIALS_PLAYLIST, items: [
    { id: '2WuhN1p9e6A', title: 'Rogue Agent — a shoe by Flaukowski | Kannaka TV', description: 'aliveshoes.com/rogue-agent', published: '2026-10-19', seconds: 49, privacy: 'public' },
    { id: 'Te0NQK3qitE', title: 'Rogue Agent (15s)', description: '', published: '2026-10-19', seconds: 16, privacy: 'public' },
    { id: 'LLLLLLLLLLL', title: 'GSP-999 — a programme title in the wrong playlist', description: '', published: '2026-10-19', seconds: 300, privacy: 'public' },
    { id: 'PPPPPPPPPPP', title: 'private spot', description: '', published: '2026-10-19', seconds: 30, privacy: 'private' },
    { id: 'SSSSSSSSSSS', title: 'too short', description: '', published: '2026-10-19', seconds: 5, privacy: 'public' },
    { id: 'VVVVVVVVVVV', title: 'Rogue Agent — a shoe by Flaukowski #Shorts', description: '', published: '2026-10-19', seconds: 50, privacy: 'public' },
  ] },
  { playlist: 'Kannaka Radio', playlistId: 'PLr8fsczlhL9Jw_RdAMOmkdKVD9nnqPeCY', items: [
    { id: 'MMMMMMMMMMM', title: 'Kannaka — Small Rooms (WHAT PERSISTED)', description: '', published: '2026-10-01', seconds: 200, privacy: 'public' },
  ] },
];

test('build-slate shapes the Commercials playlist into spots and nothing else', () => {
  const { features, music, commercials, leftOut } = slate.shape(CAT);
  assert.deepStrictEqual(commercials.map((c) => c.ref), ['2WuhN1p9e6A', 'Te0NQK3qitE']);
  assert.strictEqual(commercials[0].title, 'Rogue Agent — a shoe by Flaukowski');
  assert.strictEqual(commercials[0].duration, 49);
  // The programme-titled 300 s item in the Commercials playlist is NOT a feature, and the 16 s one
  // is NOT silently dropped as a sub-minute track.
  assert.ok(!features.some((f) => f.ref === 'LLLLLLLLLLL'), 'a spot was shaped as a programme');
  assert.ok(!music.some((m) => m.ref === 'LLLLLLLLLLL'), 'a spot was shaped as a track');
  assert.strictEqual(music.length, 1, 'the real music video is still a music video');
  assert.ok(leftOut.some((l) => l.includes('LLLLLLLLLLL')) && leftOut.some((l) => l.includes('SSSSSSSSSSS')), 'out-of-range spots are said so, not dropped silently');
  assert.ok(leftOut.some((l) => l.includes('VVVVVVVVVVV') && /vertical/.test(l)), 'the vertical cut is left out and said so');
  assert.strictEqual(slate.check(features, music, commercials).length, 0);
});

test('build-slate refuses a spot carried twice or out of range', () => {
  const { features, music, commercials } = slate.shape(CAT);
  const twice = [...commercials, { ...commercials[0] }];
  assert.ok(slate.check(features, music, twice).some((p) => /twice/.test(p)));
  const long = [{ ...commercials[0], duration: 120 }];
  assert.ok(slate.check(features, music, long).some((p) => /120s commercial/.test(p)));
});

test('the house commercial slate in the repo is well-formed and within range', () => {
  const list = require('../data/commercials.json');
  assert.ok(Array.isArray(list));
  for (const c of list) {
    assert.match(c.ref, /^[A-Za-z0-9_-]{11}$/);
    assert.ok(c.duration >= slate.COMMERCIAL_MIN_SECONDS && c.duration <= slate.COMMERCIAL_MAX_SECONDS, `${c.ref} is ${c.duration}s`);
    assert.ok(c.title);
  }
});
