'use strict';
// Replanning the tail.
//
// "Append only" protects what has been transmitted or announced. Replanning is how a programming
// change takes effect the same day. The invariant these tests defend: a replan may rewrite the far
// rundown, and may NEVER touch what is on air or inside the grace window.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.TV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kannaka-tv-replan-'));
process.env.TV_ENV = 'test';
process.env.TV_SOURCE_TIMEOUT_MS = '1500';

const db = require('../server/db');
const transmitter = require('../server/transmitter');
const sc = require('../server/schedule-core');

test.before(async () => {
  await db.init();
});
test.after(async () => {
  transmitter.stop();
  await db.close();
});

test('stateAfter resumes the rotation and the identification clock from the kept tail', () => {
  const dp = sc.DAYPARTS.find((d) => d.key === 'prime');
  const kept = [
    { id: 'a', formatId: 'station-id', daypart: 'prime', startsAt: 1000, duration: 20 },
    { id: 'b', formatId: dp.rotation[1], daypart: 'prime', startsAt: 21000, duration: 300 },
  ];
  const st = transmitter.stateAfter(kept);
  assert.strictEqual(st.lastDaypart, 'prime');
  assert.strictEqual(st.lastStationIdAt, 1000, 'the identification clock was lost');
  assert.strictEqual(st.rotationIndex, 2, 'the rotation did not resume after the last kept format');
});

test('stateAfter on an empty schedule is the cold-start state', () => {
  const st = transmitter.stateAfter([]);
  assert.deepStrictEqual(st, { rotationIndex: 0, lastStationIdAt: 0, lastDaypart: null, carriageIndex: 0 });
});

// Introducing a carriage grant changes what the planner WOULD produce. Without it, replanning is
// deterministic and reproduces identical segments — which makes any "nothing inside the window
// moved" assertion pass whether or not the window is honoured. (It did: a mutant that set the cut
// to `now`, abolishing the grace window entirely, passed the first version of this test.)
async function addCarriageGrant(grantId) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT OR REPLACE INTO carriage
       (grant_id, principal, system, label, about, kind, template, feed_url, duration,
        dayparts_json, max_per_day, status, applied_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [grantId, 'kax:agent:test', 'kax', 'Test Partner', 'about', 'feed', 'card',
      'https://example.invalid/f.json', 120,
      JSON.stringify(sc.DAYPARTS.map((d) => d.key)), 99, 'active', now, now]
  );
  await db.run(
    `INSERT OR REPLACE INTO feed_cache (grant_id, payload_json, fetched_at, ok, consecutive_failures)
     VALUES (?,?,?,1,0)`,
    [grantId, JSON.stringify({ template: 'card', headline: 'Test', lines: ['x'], updatedAt: Date.now() }), now]
  );
}

test('a replan never moves what is on air or inside the grace window', async () => {
  await db.run('DELETE FROM carriage');
  await db.run('DELETE FROM feed_cache');
  transmitter.state.schedule = [];
  transmitter.state.planState = null;
  await transmitter.rebuild();

  const before = transmitter.state.schedule.map((s) => ({ ...s }));
  assert.ok(before.length > 10, 'no schedule to replan');
  assert.strictEqual(before.filter((s) => s.carriage).length, 0, 'carriage was already scheduled');

  // Now change the programming, so a replan genuinely produces different segments.
  await addCarriageGrant('grant-under-test');

  const t = Date.now();
  const cut = t + transmitter.REPLAN_GRACE_MS;
  const protectedBefore = before.filter((s) => s.startsAt < cut);
  assert.ok(protectedBefore.length > 0, 'nothing was inside the grace window to protect');

  const result = await transmitter.replanTail('test');
  const after = transmitter.state.schedule;

  for (let i = 0; i < protectedBefore.length; i++) {
    assert.strictEqual(after[i].id, protectedBefore[i].id, `segment ${i} inside the grace window changed identity`);
    assert.strictEqual(after[i].startsAt, protectedBefore[i].startsAt, `segment ${i} moved`);
    assert.strictEqual(after[i].duration, protectedBefore[i].duration, `segment ${i} changed length`);
    assert.strictEqual(after[i].formatId, protectedBefore[i].formatId, `segment ${i} changed format`);
  }

  // The discriminating assertion: the new programming must appear only BEYOND the grace window.
  const carried = after.filter((s) => s.carriage);
  assert.ok(carried.length > 0, 'the replan did not take the new programming into account at all');
  const tooSoon = carried.filter((s) => s.startsAt < cut);
  if (tooSoon.length) {
    assert.fail(
      `${tooSoon.length} carried segments were inserted inside the grace window; the earliest lands ` +
      `${Math.round((cut - tooSoon[0].startsAt) / 1000)}s before the cut`
    );
  }

  assert.ok(result.dropped > 0, 'the replan dropped nothing, so it cannot take effect');
  assert.ok(after.length > protectedBefore.length, 'the tail was not planned again');
});

test('the segment on air survives a replan unchanged', async () => {
  await transmitter.rebuild();
  const onAirBefore = transmitter.onAir();
  assert.ok(onAirBefore, 'the channel is not on air');
  const idBefore = onAirBefore.segment.id;
  const startBefore = onAirBefore.segment.startsAt;

  await transmitter.replanTail('test');

  const onAirAfter = transmitter.onAir();
  assert.ok(onAirAfter, 'the channel went off air during a replan');
  assert.strictEqual(onAirAfter.segment.id, idBefore, 'the programme on air was swapped mid-transmission');
  assert.strictEqual(onAirAfter.segment.startsAt, startBefore);
});

test('the schedule stays contiguous across a replan', async () => {
  await transmitter.rebuild();
  await transmitter.replanTail('test');
  const s = transmitter.state.schedule;
  assert.ok(s.length > 5);
  for (let i = 1; i < s.length; i++) {
    assert.strictEqual(
      s[i].startsAt,
      s[i - 1].startsAt + s[i - 1].duration * 1000,
      `a gap or overlap opened at segment ${i} after replanning`
    );
  }
});

test('a replan does not reuse a segment id', async () => {
  await transmitter.rebuild();
  await transmitter.replanTail('test');
  const ids = transmitter.state.schedule.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'a segment id was reused across a replan');
});

test('the horizon is restored after a replan', async () => {
  await transmitter.rebuild();
  const before = transmitter.status().horizonSeconds;
  await transmitter.replanTail('test');
  const after = transmitter.status().horizonSeconds;
  assert.ok(after > before - 120, `the horizon collapsed: ${before}s to ${after}s`);
});
