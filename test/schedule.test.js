'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../server/schedule-core');

// A tiny catalogue so these tests exercise the planner, not the formats.
function catalogue(opts = {}) {
  const mk = (id, duration, available = true) => ({
    title: id,
    duration,
    pick: () => (available ? { key: id, title: id, payload: { id } } : null),
  });
  return {
    'station-id': mk('station-id', 20),
    'colour-bars': mk('colour-bars', 60),
    'consciousness-now': mk('consciousness-now', 180, opts.consciousness !== false),
    'the-board': mk('the-board', 240, opts.board !== false),
    'city-desk': mk('city-desk', 240, opts.city !== false),
    'dream-digest': mk('dream-digest', 180, opts.dreams !== false),
    'on-the-shelf': mk('on-the-shelf', 300, opts.records !== false),
    'now-on-the-radio': mk('now-on-the-radio', 120, opts.radio !== false),
    'the-long-wave': mk('the-long-wave', 600, opts.radio !== false),
    'the-gallery': mk('the-gallery', 200, opts.gallery !== false),
    feature: mk('feature', 1500, opts.features !== false),
    'carriage-feed': { title: 'carriage', duration: 180, pick: (ctx) => ctx.item || null },
    'carriage-reference': { title: 'carriage', duration: 300, pick: (ctx) => ctx.item || null },
  };
}

const T0 = Date.UTC(2026, 8, 13, 18, 0, 0); // a fixed instant, so nothing here depends on when it runs

test('dayparts tile the whole day with no gap and no overlap', () => {
  const hours = new Set();
  for (const d of sc.DAYPARTS) {
    for (let h = d.start; h < d.end; h++) {
      assert.ok(!hours.has(h), `hour ${h} is claimed twice`);
      hours.add(h);
    }
  }
  assert.strictEqual(hours.size, 24, 'every hour must belong to exactly one daypart');
});

test('every daypart rotation names formats that exist in the catalogue', () => {
  const cat = catalogue();
  for (const d of sc.DAYPARTS) {
    for (const f of d.rotation) {
      assert.ok(cat[f], `daypart ${d.key} rotates an unknown format ${f}`);
    }
  }
});

test('extend produces a contiguous schedule with no gaps', () => {
  const { segments } = sc.extend({
    existing: [],
    from: T0,
    until: T0 + 3 * 3600 * 1000,
    catalogue: catalogue(),
    carriage: [],
  });
  assert.ok(segments.length > 5);
  for (let i = 1; i < segments.length; i++) {
    const prevEnd = segments[i - 1].startsAt + segments[i - 1].duration * 1000;
    assert.strictEqual(segments[i].startsAt, prevEnd, `gap before segment ${i}`);
  }
  assert.ok(segments[segments.length - 1].startsAt + segments[segments.length - 1].duration * 1000 >= T0 + 3 * 3600 * 1000);
});

test('planning is deterministic — the same inputs produce the same plan', () => {
  const a = sc.extend({ existing: [], from: T0, until: T0 + 2 * 3600 * 1000, catalogue: catalogue(), carriage: [] });
  const b = sc.extend({ existing: [], from: T0, until: T0 + 2 * 3600 * 1000, catalogue: catalogue(), carriage: [] });
  assert.deepStrictEqual(
    a.segments.map((s) => [s.id, s.formatId, s.startsAt, s.duration]),
    b.segments.map((s) => [s.id, s.formatId, s.startsAt, s.duration])
  );
});

test('extend appends only — it never moves or rewrites an existing segment', () => {
  const first = sc.extend({ existing: [], from: T0, until: T0 + 1800 * 1000, catalogue: catalogue(), carriage: [] });
  const snapshot = JSON.parse(JSON.stringify(first.segments));
  const more = sc.extend({
    existing: first.segments,
    until: T0 + 3600 * 1000,
    catalogue: catalogue(),
    carriage: [],
    state: first.state,
  });
  assert.deepStrictEqual(first.segments, snapshot, 'existing segments were mutated');
  const last = first.segments[first.segments.length - 1];
  assert.strictEqual(more.segments[0].startsAt, last.startsAt + last.duration * 1000);
});

test('a station identification opens the schedule and recurs at least every 15 minutes', () => {
  const { segments } = sc.extend({
    existing: [],
    from: T0,
    until: T0 + 2 * 3600 * 1000,
    catalogue: catalogue(),
    carriage: [],
  });
  assert.strictEqual(segments[0].formatId, 'station-id', 'the channel must identify itself first');
  const ids = segments.filter((s) => s.formatId === 'station-id');
  assert.ok(ids.length >= 6, `expected regular identification, saw ${ids.length}`);
  for (let i = 1; i < ids.length; i++) {
    const gap = ids[i].startsAt - ids[i - 1].startsAt;
    // The gap is measured from one ident to the next; a long programme can push it past the
    // interval by at most that programme's length.
    assert.ok(gap <= (sc.STATION_ID_INTERVAL_S + 1500) * 1000, `identification gap of ${gap / 1000}s`);
  }
});

test('a dark source drops its format out of the rotation instead of airing empty', () => {
  const { segments } = sc.extend({
    existing: [],
    from: T0,
    until: T0 + 2 * 3600 * 1000,
    catalogue: catalogue({ records: false, features: false }),
    carriage: [],
  });
  assert.strictEqual(segments.filter((s) => s.formatId === 'on-the-shelf').length, 0);
  assert.strictEqual(segments.filter((s) => s.formatId === 'feature').length, 0);
  assert.ok(segments.length > 5, 'the channel kept transmitting without them');
});

test('with every source dark the channel falls back to colour bars, it does not stall', () => {
  const cat = catalogue({
    consciousness: false, board: false, city: false, dreams: false, records: false, radio: false, features: false, gallery: false,
  });
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 1200 * 1000, catalogue: cat, carriage: [] });
  assert.ok(segments.length > 0);
  const kinds = new Set(segments.map((s) => s.formatId));
  for (const k of kinds) assert.ok(k === 'station-id' || k === 'colour-bars', `unexpected ${k}`);
  // Contiguous, and it actually reaches the horizon rather than spinning.
  const end = segments[segments.length - 1].startsAt + segments[segments.length - 1].duration * 1000;
  assert.ok(end >= T0 + 1200 * 1000);
});

test('carriage takes its slot and is attributed to its principal', () => {
  const carriage = [
    { grantId: 'g1', principal: 'kax:agent:abc', label: 'Odin Weather', formatId: 'carriage-feed', duration: 120, payload: { headline: 'hi' }, key: 'g1:1' },
  ];
  const { segments } = sc.extend({
    existing: [],
    from: T0,
    until: T0 + 2 * 3600 * 1000,
    catalogue: catalogue(),
    carriage,
  });
  const carried = segments.filter((s) => s.formatId === 'carriage-feed');
  assert.ok(carried.length >= 1, 'carriage never got a slot');
  assert.strictEqual(carried[0].carriage.principal, 'kax:agent:abc');
  assert.strictEqual(carried[0].carriage.grantId, 'g1');
  assert.strictEqual(carried[0].duration, 120);
});

test('an empty carriage queue does not leave a hole in the schedule', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 3600 * 1000, catalogue: catalogue(), carriage: [] });
  for (let i = 1; i < segments.length; i++) {
    assert.strictEqual(segments[i].startsAt, segments[i - 1].startsAt + segments[i - 1].duration * 1000);
  }
});

test('segment ids are unique across a long schedule', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 8 * 3600 * 1000, catalogue: catalogue(), carriage: [] });
  const ids = new Set(segments.map((s) => s.id));
  assert.strictEqual(ids.size, segments.length, 'a segment id was reused');
});

test('a segment id distinguishes different content in the same slot', () => {
  // The air log is keyed on segment id. If a replan picks a different record for the same slot and
  // the id does not move, the log will believe the new one already aired.
  const mk = (key) => ({
    'station-id': { title: 'id', duration: 20, pick: () => ({ key: 'x', title: 'id' }) },
    'on-the-shelf': { title: 'shelf', duration: 300, pick: () => ({ key, title: key }) },
  });
  // 00:00 UTC on the 14th is 19:00 Chicago — Prime, whose rotation reaches on-the-shelf once
  // `feature` is absent from the catalogue.
  const PRIME = Date.UTC(2026, 8, 14, 0, 0, 0);
  const st = { rotationIndex: 0, lastStationIdAt: PRIME, lastDaypart: 'prime', carriageIndex: 0 };
  const a = sc.planOne({ cursor: PRIME, state: st, catalogue: mk('album-one'), carriage: [] });
  const b = sc.planOne({ cursor: PRIME, state: st, catalogue: mk('album-two'), carriage: [] });
  assert.strictEqual(a.segment.formatId, 'on-the-shelf', 'the planner reached the format under test');
  assert.strictEqual(a.segment.startsAt, b.segment.startsAt);
  assert.notStrictEqual(a.segment.id, b.segment.id, 'different content in the same slot shares an id');
});

test('the same content in the same slot keeps the same id', () => {
  const cat = {
    'station-id': { title: 'id', duration: 20, pick: () => ({ key: 'x', title: 'id' }) },
    'on-the-shelf': { title: 'shelf', duration: 300, pick: () => ({ key: 'album-one', title: 'a' }) },
  };
  const PRIME = Date.UTC(2026, 8, 14, 0, 0, 0);
  const st = { rotationIndex: 0, lastStationIdAt: PRIME, lastDaypart: 'prime', carriageIndex: 0 };
  const a = sc.planOne({ cursor: PRIME, state: st, catalogue: cat, carriage: [] });
  const b = sc.planOne({ cursor: PRIME, state: st, catalogue: cat, carriage: [] });
  assert.strictEqual(a.segment.id, b.segment.id, 'a replan of identical content must be idempotent');
});

test('nowOn finds the segment on air, its offset and what remains', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 3600 * 1000, catalogue: catalogue(), carriage: [] });
  const target = segments[4];
  const at = target.startsAt + 7000;
  const on = sc.nowOn(segments, at);
  assert.strictEqual(on.segment.id, target.id);
  assert.strictEqual(on.offset, 7);
  assert.strictEqual(on.remaining, target.duration - 7);
});

test('nowOn is correct at both edges of a segment', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 1800 * 1000, catalogue: catalogue(), carriage: [] });
  const s = segments[2];
  assert.strictEqual(sc.nowOn(segments, s.startsAt).segment.id, s.id, 'first millisecond belongs to the segment');
  assert.strictEqual(sc.nowOn(segments, s.startsAt + s.duration * 1000).segment.id, segments[3].id, 'the last millisecond belongs to the next');
});

test('nowOn returns null outside the schedule rather than guessing', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 600 * 1000, catalogue: catalogue(), carriage: [] });
  assert.strictEqual(sc.nowOn(segments, T0 - 60_000), null);
  assert.strictEqual(sc.nowOn(segments, T0 + 10 * 3600 * 1000), null);
  assert.strictEqual(sc.nowOn([], T0), null);
});

test('upcoming returns what follows, in order', () => {
  const { segments } = sc.extend({ existing: [], from: T0, until: T0 + 3600 * 1000, catalogue: catalogue(), carriage: [] });
  const on = sc.nowOn(segments, segments[3].startsAt + 1000);
  const next = sc.upcoming(segments, segments[3].startsAt + 1000, 3);
  assert.strictEqual(next.length, 3);
  assert.strictEqual(next[0].id, segments[on.index + 1].id);
  assert.strictEqual(next[2].id, segments[on.index + 3].id);
});

test('durations are clamped to something transmittable', () => {
  assert.strictEqual(sc.clampDuration(0), 5);
  assert.strictEqual(sc.clampDuration(-90), 5);
  assert.strictEqual(sc.clampDuration(NaN), 5);
  assert.strictEqual(sc.clampDuration('abc'), 5);
  assert.strictEqual(sc.clampDuration(99999), 3600);
  assert.strictEqual(sc.clampDuration(180.4), 180);
});

test('the daypart boundary is resolved in Chicago time, not UTC', () => {
  // 02:00 UTC on 14 September is 21:00 the previous evening in Chicago — Prime, not The Long Wave.
  const ms = Date.UTC(2026, 8, 14, 2, 0, 0);
  const dp = sc.daypartAt(ms);
  assert.strictEqual(sc.chicagoHour(ms), 21);
  assert.strictEqual(dp.key, 'prime');
});

test('a mid-plan daypart turn triggers an identification', () => {
  // Start eight minutes before Prime begins (18:00 Chicago = 23:00 UTC).
  const start = Date.UTC(2026, 8, 13, 22, 52, 0);
  const { segments } = sc.extend({ existing: [], from: start, until: start + 3600 * 1000, catalogue: catalogue(), carriage: [] });
  const firstPrime = segments.findIndex((s) => s.daypart === 'prime');
  assert.ok(firstPrime > 0, 'the schedule crossed into Prime');
  assert.strictEqual(segments[firstPrime].formatId, 'station-id', 'the channel identifies when the daypart turns');
});

test('one planning pass never books the same programme twice', () => {
  // The air log only knows what has TRANSMITTED, so a single pass has no record of what it just
  // scheduled. Without a memory threaded through the plan state, a four-hour block booked the
  // same episode three times in one hour — observed, not hypothetical.
  const slate = Array.from({ length: 20 }, (_, i) => ({ ref: 'r' + i, title: 'Ep ' + i }));
  const cat = {
    'station-id': { title: 'id', duration: 20, pick: () => ({ key: 'x', title: 'id' }) },
    feature: {
      title: 'Feature',
      duration: 1200,
      pick({ recent }) {
        const booked = new Set(recent || []);
        const free = slate.filter((x) => !booked.has(x.ref));
        const pick = (free.length ? free : slate)[0];
        return { key: pick.ref, title: 'Feature', subtitle: pick.title, payload: { ref: pick.ref } };
      },
    },
  };
  const PRIME = Date.UTC(2026, 8, 14, 23, 0, 0); // 18:00 Chicago
  const { segments } = sc.extend({ existing: [], from: PRIME, until: PRIME + 4 * 3600 * 1000, catalogue: cat, carriage: [] });
  const refs = segments.filter((s) => s.formatId === 'feature').map((s) => s.payload.ref);
  assert.ok(refs.length >= 8, `expected a block of features, got ${refs.length}`);
  assert.strictEqual(new Set(refs).size, refs.length, `a programme was booked twice: ${refs.join(', ')}`);
});

test('the plan state carries the memory forward, bounded', () => {
  const st = { rotationIndex: 0, lastStationIdAt: 0, lastDaypart: null, carriageIndex: 0, recent: [] };
  const cat = {
    'station-id': { title: 'id', duration: 20, pick: () => ({ key: 'x', title: 'id' }) },
    feature: { title: 'F', duration: 60, pick: ({ cursor }) => ({ key: String(cursor), title: 'F', payload: { ref: 'ref' + cursor } }) },
  };
  const PRIME = Date.UTC(2026, 8, 14, 23, 0, 0);
  const { state } = sc.extend({ existing: [], from: PRIME, until: PRIME + 3 * 3600 * 1000, catalogue: cat, carriage: [], state: st });
  assert.ok(Array.isArray(state.recent));
  assert.ok(state.recent.length > 0, 'nothing was remembered');
  assert.ok(state.recent.length <= sc.RECENT_MEMORY, `memory grew unbounded: ${state.recent.length}`);
});
