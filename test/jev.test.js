'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildCatalogue } = require('../server/formats');
const sc = require('../server/schedule-core');

// Jev the Band, carried from its own archive.
//
// The format is the easy half. These tests are mostly about the ways a carried band goes wrong:
// a dark source must degrade the channel rather than break it, one jam must not be booked twice
// in a row, and the bed has to be seekable or a viewer who tunes in late restarts the band for
// themselves and hears a different performance from everyone else — which is the one promise this
// whole channel is built on.

const JAM = (over = {}) => ({
  id: 'jam-1',
  title: 'Slow tide over a cold harbour',
  prompt: 'slow tide over a cold harbour',
  startedAt: Date.UTC(2026, 8, 21, 2, 0, 0),
  endedAt: Date.UTC(2026, 8, 21, 2, 9, 0),
  durationSeconds: 540,
  songs: [
    { prompt: 'slow tide over a cold harbour', at: 0 },
    { prompt: 'the tide turns', at: 260 },
  ],
  audioUrl: 'https://jev.example/api/archive/jam-1/audio',
  page: 'https://jev.example/?archive=jam-1',
  ...over,
});

const snapWith = (jev) => ({
  consciousness: { ok: false },
  markets: { ok: false },
  radio: { ok: false },
  records: { ok: false },
  city: { ok: false },
  dreams: { ok: false },
  gallery: { ok: false },
  jev,
  at: Date.now(),
});

const rnd = () => 0;

test('a jam becomes a segment with a seekable bed at its own host', () => {
  const c = buildCatalogue(snapWith({ ok: true, jams: [JAM()] }));
  const item = c['jev-the-band'].pick({ rnd, recent: [] });

  assert.ok(item, 'the band should be pickable when the archive has a jam');
  assert.equal(item.title, 'Slow tide over a cold harbour');
  assert.equal(item.key, 'jev:jam-1');

  // Carried by reference: the audio stays where it already lives.
  assert.equal(item.bed.url, 'https://jev.example/api/archive/jam-1/audio');
  assert.ok(/^https:\/\/jev\.example\//.test(item.bed.url), 'the bed is not served from this box');
  // `track`, not `stream`: the player seeks a track to seg.offset so every viewer is at the same
  // second of the same performance. A stream would restart the band for whoever tuned in late.
  assert.equal(item.bed.kind, 'track');

  assert.equal(item.payload.jamId, 'jam-1');
  assert.equal(item.payload.songs.length, 2);
  assert.equal(item.payload.players.length, 6);
  assert.deepEqual(
    item.payload.players.map((p) => p.name),
    ['ROOK', 'MOSS', 'JUNE', 'KIT', 'LUX', 'PATCH'],
  );
  for (const player of item.payload.players)
    assert.match(player.colour, /^#[0-9a-f]{6}$/i, player.name + ' carries its own colour');
});

test('a dark archive takes the band off air without taking the channel down', () => {
  for (const jev of [undefined, null, { ok: false, reason: 'ECONNREFUSED' }, { ok: true, jams: [] }]) {
    const c = buildCatalogue(snapWith(jev));
    assert.equal(
      c['jev-the-band'].pick({ rnd, recent: [] }),
      null,
      'an unavailable source returns null rather than throwing',
    );
  }
});

test('the planner routes past the band when its source is dark, and still fills the hour', () => {
  const catalogue = buildCatalogue(snapWith({ ok: false, reason: 'down' }));
  // Prime, where the band sits in the rotation.
  const from = Date.UTC(2026, 8, 21, 23, 0, 0); // 18:00 America/Chicago
  const { segments } = sc.extend({ existing: [], from, until: from + 3600_000, catalogue });
  assert.ok(segments.length > 0, 'the hour is still programmed');
  assert.ok(
    segments.every((s) => Number.isFinite(s.startsAt) && s.duration > 0),
    'every segment the planner emits is playable',
  );
  assert.equal(
    segments.filter((s) => s.formatId === 'jev-the-band').length,
    0,
    'nothing schedules a band that has no jam',
  );
});

test('two jams do not book the same one twice in a pass', () => {
  const c = buildCatalogue(snapWith({ ok: true, jams: [JAM(), JAM({ id: 'jam-2', title: 'Second' })] }));
  const first = c['jev-the-band'].pick({ rnd, recent: [] });
  const second = c['jev-the-band'].pick({ rnd, recent: [first.key] });
  assert.notEqual(second.key, first.key, 'the second pick avoids what the first booked');
});

test('one jam still airs when it is the only one, rather than going dark', () => {
  const c = buildCatalogue(snapWith({ ok: true, jams: [JAM()] }));
  const again = c['jev-the-band'].pick({ rnd, recent: ['jev:jam-1'] });
  assert.ok(again, 'a repeat beats a blank screen when the archive holds one jam');
  assert.equal(again.key, 'jev:jam-1');
});

test('the band is in the rotation where a five-minute music slot belongs', () => {
  const dayparts = sc.DAYPARTS || [];
  const carrying = dayparts.filter((d) => (d.rotation || []).includes('jev-the-band'));
  assert.ok(carrying.length >= 1, 'the band has to be in a rotation or it never airs');
  for (const d of carrying)
    assert.ok(
      ['prime', 'late-signal'].includes(d.key),
      'the band belongs in Prime or Late Signal, not the morning briefing: ' + d.key,
    );
});

test('the segment is long enough to be a performance and short enough to be television', () => {
  const c = buildCatalogue(snapWith({ ok: true, jams: [JAM()] }));
  const duration = c['jev-the-band'].duration;
  assert.ok(duration >= 180, 'shorter than three minutes is a clip, not a set');
  assert.ok(duration <= 600, 'longer than ten minutes outruns the longest possible jam');
});

test('the band DOES air in Prime once the archive has a jam', () => {
  const catalogue = buildCatalogue(snapWith({ ok: true, jams: [JAM(), JAM({ id: 'jam-2' })] }));
  const from = Date.UTC(2026, 8, 21, 23, 0, 0); // 18:00 America/Chicago
  const { segments } = sc.extend({ existing: [], from, until: from + 7200_000, catalogue });
  const aired = segments.filter((s) => s.formatId === 'jev-the-band');
  assert.ok(aired.length > 0, 'a rotation entry that never airs is decoration');
  for (const seg of aired) {
    assert.equal(seg.bed.kind, 'track', 'the bed stays seekable through the planner');
    assert.ok(seg.bed.url.startsWith('https://jev.example/'), 'and still points at its own host');
    assert.equal(seg.duration, 300);
  }
});
