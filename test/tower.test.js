'use strict';
// The office on floor 11.
//
// ⚠⚠ These exist because of a real defect. KAX serves its single-page app from a catch-all, so ANY
// unknown path answers **200 with HTML** instead of 404. The first version of tower.js posted to
// `/tower/storey/11/panel` with no `/api` prefix, got a 200 back, and reported success — the wall
// stayed blank for as long as it took someone to look at it. A status-only check is weaker than
// what it checks.

const test = require('node:test');
const assert = require('node:assert');

process.env.KAX_TOWER_STOREY = '11';
process.env.KAX_TOWER_CREDENTIAL = 'twr_test_credential';
process.env.TV_ENV = 'test';

const tower = require('../server/tower');

const SPA_HTML = '<!DOCTYPE html>\n<html lang="en">\n  <head><title>KAX</title></head>\n</html>';

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

const reply = (status, body) => async () => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const NOW = { ok: true, daypart: { label: 'Prime' }, now: { title: 'The Board', subtitle: 'A claim', payload: {} } };

test('every API path carries the /api prefix exactly once, whatever the base looks like', () => {
  assert.strictEqual(tower.apiUrl('/tower/storey/11/panel'), 'https://kax.ninja-portal.com/api/tower/storey/11/panel');
  assert.ok(tower.apiUrl('/city/say').endsWith('/api/city/say'));
  assert.strictEqual((tower.apiUrl('/city/say').match(/\/api\//g) || []).length, 1, 'the prefix was doubled');
});

test('a 200 of HTML from the catch-all is NOT a success', async () => {
  await withFetch(reply(200, SPA_HTML), async () => {
    const r = await tower.writePanel(NOW);
    assert.strictEqual(r.ok, false, 'the SPA catch-all was reported as a successful panel write');
    assert.strictEqual(r.spa, true, 'the catch-all was not identified as such');
    assert.strictEqual(r.status, 200, 'the real status should still be reported');
  });
});

test('a 200 of JSON with ok:false is not a success either', async () => {
  await withFetch(reply(200, { ok: false, error: 'unknown floor credential' }), async () => {
    const r = await tower.writePanel(NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'unknown floor credential');
  });
});

test('a genuine 200 of JSON with ok:true is a success', async () => {
  await withFetch(reply(200, { ok: true, floorNo: 11 }), async () => {
    const r = await tower.writePanel(NOW);
    assert.strictEqual(r.ok, true, 'a real success was rejected');
    assert.strictEqual(r.spa, false);
  });
});

test('a 401 is not a success', async () => {
  await withFetch(reply(401, { ok: false, error: 'refused floor credential' }), async () => {
    assert.strictEqual((await tower.writePanel(NOW)).ok, false);
  });
});

test('the panel is ASCII, six lines at most, and says what is on', async () => {
  let sent = null;
  await withFetch(
    async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    async () => {
      await tower.writePanel({
        ok: true,
        daypart: { label: 'Prime' },
        now: { title: 'On the Shelf', subtitle: 'Night One — The Door', payload: {} },
        next: [{ title: 'City Desk', subtitle: '2 in The street' }, { title: 'The Board', subtitle: 'Φ rising' }],
      });
    }
  );
  assert.ok(sent, 'nothing was sent');
  assert.ok(sent.lines.length <= 6, `the tower accepts six lines, we sent ${sent.lines.length}`);
  // Non-ASCII through an ssh heredoc became mojibake on this tower once; the panel stays ASCII.
  const all = [sent.headline, ...sent.lines].join('\n');
  assert.ok(!/[^\x20-\x7E\n]/.test(all), `non-ASCII reached the wall: ${JSON.stringify(all)}`);
  assert.ok(sent.lines[0].startsWith('NOW: On the Shelf'), 'the wall does not say what is on');
  assert.ok(all.includes('tv.ninja-portal.com'), 'the wall does not say where to watch');
});

test('only an image from our own hosts reaches the wall', async () => {
  const send = async (cover) => {
    let sent = null;
    await withFetch(
      async (url, opts) => {
        sent = JSON.parse(opts.body);
        return { status: 200, text: async () => JSON.stringify({ ok: true }) };
      },
      async () => {
        await tower.writePanel({
          ok: true,
          daypart: { label: 'Prime' },
          now: { title: 'On the Shelf', subtitle: '', payload: { album: { cover } } },
        });
      }
    );
    return sent;
  };
  assert.ok((await send('https://records.ninja-portal.com/album/x/file/cover.png')).assetUrl, 'our own cover was dropped');
  assert.strictEqual((await send('https://evil.example.com/x.png')).assetUrl, undefined, 'a foreign image reached the wall');
  assert.strictEqual((await send('http://records.ninja-portal.com/x.png')).assetUrl, undefined, 'a plaintext image reached the wall');
});

test('the signature check rejects an absent, short or wrong signature', () => {
  process.env.TOWER_WEBHOOK_SECRET = 'test-secret';
  delete require.cache[require.resolve('../server/config')];
  delete require.cache[require.resolve('../server/tower')];
  const t = require('../server/tower');
  const body = Buffer.from('{"kind":"chat.said"}');

  assert.strictEqual(t.verifySignature(body, undefined).ok, false);
  assert.strictEqual(t.verifySignature(body, 'sha256=deadbeef').ok, false, 'a short signature passed');
  const crypto = require('node:crypto');
  const good = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
  assert.strictEqual(t.verifySignature(body, good).ok, true, 'a correct signature was rejected');
  // One flipped character must fail, and must not throw on the length-equal path.
  const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
  assert.strictEqual(t.verifySignature(body, bad).ok, false, 'a forged signature of the right length passed');
});
