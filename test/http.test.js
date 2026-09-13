'use strict';
// Route-level tests, driving the real handler.
//
// The analytics service shipped a broken upload route because its tests only exercised the pure
// core; the lesson recorded there was that there were no route-level tests. These drive
// `route()` itself with real request and response objects.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { URL } = require('node:url');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kannaka-tv-test-'));
process.env.TV_DATA_DIR = DATA;
process.env.TV_ADMIN_TOKEN = 'test-operator-token';
process.env.TV_ENV = 'test';

const db = require('../server/db');
const { handleRequest } = require('../server/index');
const transmitter = require('../server/transmitter');

// --- a request/response pair the real handler cannot tell from the server's ------------------

function mkReq(method, url, { body, headers } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign({}, headers);
  if (body !== undefined) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    req.headers['content-length'] = String(buf.length);
    process.nextTick(() => {
      req.emit('data', buf);
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  req.destroy = () => {};
  return req;
}

function mkRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
    end(payload) {
      this.body = payload ? payload.toString() : '';
      this.done(this);
    },
  };
  res.finished = new Promise((resolve) => {
    res.done = resolve;
  });
  return res;
}

async function call(method, url, opts) {
  const req = mkReq(method, url, opts);
  const res = mkRes();
  // handleRequest owns the error mapping too, so these tests exercise the shipping behaviour
  // rather than a copy of it that can drift.
  await handleRequest(req, res, new URL(url, 'http://localhost'));
  await res.finished;
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* html or text */
  }
  return { status: res.statusCode, body: res.body, json, headers: res.headers };
}

const OP = { authorization: 'Bearer test-operator-token' };

test.before(async () => {
  await db.init();
  // One rebuild, so the channel has a schedule. Sources may be unreachable in CI; the transmitter
  // is required to produce a schedule anyway.
  await transmitter.rebuild();
});

test.after(async () => {
  transmitter.stop();
  await db.close();
});

// ------------------------------------------------------------------ broadcast

test('GET /api/health reports the channel', async () => {
  const r = await call('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.channel, 'Kannaka TV');
  assert.ok(typeof r.json.onAir === 'boolean');
  assert.ok(r.json.auth.available.includes('kax'));
});

test('GET /api/now serves a segment with everything an agent needs', async () => {
  const r = await call('GET', '/api/now');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true, 'the channel is not on air after a rebuild');
  const n = r.json.now;
  for (const k of ['id', 'format', 'title', 'startsAt', 'endsAt', 'duration', 'payload', 'offset', 'remaining']) {
    assert.ok(k in n, `/api/now is missing ${k}`);
  }
  assert.ok(n.offset >= 0 && n.offset <= n.duration);
  assert.strictEqual(n.endsAt - n.startsAt, n.duration * 1000);
  assert.ok(Array.isArray(r.json.next));
});

test('the agent track and the human track read the same schedule', async () => {
  const now = await call('GET', '/api/now');
  const guide = await call('GET', '/api/guide?hours=1');
  const ids = guide.json.segments.map((s) => s.id);
  assert.ok(ids.includes(now.json.now.id), 'what is on air is not in the guide');
});

test('the guide carries no payloads — it announces the running order only', async () => {
  const r = await call('GET', '/api/guide?hours=3');
  assert.ok(r.json.segments.length > 0);
  for (const s of r.json.segments) {
    assert.ok(!('payload' in s), 'the guide shipped a payload it will re-read anyway');
    assert.ok(s.title && s.startsAt && s.duration);
  }
});

test('the guide hours parameter is clamped', async () => {
  const big = await call('GET', '/api/guide?hours=9999');
  assert.strictEqual(big.json.hours, 12);
  const small = await call('GET', '/api/guide?hours=-5');
  assert.strictEqual(small.json.hours, 1);
  const junk = await call('GET', '/api/guide?hours=abc');
  assert.strictEqual(junk.json.hours, 3);
});

test('GET /api/segment/:id finds a scheduled segment and 404s an invented one', async () => {
  const now = await call('GET', '/api/now');
  const good = await call('GET', '/api/segment/' + now.json.now.id);
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.json.segment.id, now.json.now.id);

  const bad = await call('GET', '/api/segment/nope-not-real');
  assert.strictEqual(bad.status, 404);
});

test('GET /api/formats publishes the carriage contract', async () => {
  const r = await call('GET', '/api/formats');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.feedTemplates.card);
  assert.ok(r.json.feedTemplates.list);
  assert.ok(r.json.feedTemplates.metric);
  assert.ok(r.json.referenceProviders.youtube);
  assert.strictEqual(r.json.dayparts.length, 6);
  assert.ok(r.json.imageHosts.includes('.ninja-portal.com'));
});

// ------------------------------------------------------------------- identity

test('an unsigned caller is not identified', async () => {
  const r = await call('GET', '/api/auth/me');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error, 'not_signed_in');
});

test('the operator token identifies the operator', async () => {
  const r = await call('GET', '/api/auth/me', { headers: OP });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.operator, true);
  assert.strictEqual(r.json.principal, 'tv:operator:nick');
});

test('a wrong operator token is refused', async () => {
  const r = await call('GET', '/api/auth/me', { headers: { authorization: 'Bearer test-operator-toke' } });
  assert.strictEqual(r.status, 401, 'a token of a different length was accepted');
  const r2 = await call('GET', '/api/auth/me', { headers: { authorization: 'Bearer XXXX-XXXXXXXX-XXXXX' } });
  assert.strictEqual(r2.status, 401, 'a same-length wrong token was accepted');
});

test('an unknown identity system is refused and never falls through', async () => {
  const r = await call('POST', '/api/auth/session', { body: { system: 'myself', proof: 'x'.repeat(20) } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'provider_unknown');
});

test('a provider named in the ADR but not yet wired refuses rather than pretends', async () => {
  const r = await call('POST', '/api/auth/session', { body: { system: 'spacechild', proof: 'x'.repeat(20) } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'provider_unavailable');
});

// ------------------------------------------------------------------ carriage

test('carriage requires a signed-in principal', async () => {
  const r = await call('POST', '/api/carriage/apply', { body: { label: 'Anon', kind: 'feed' } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error, 'not_signed_in');
});

test('a carriage application is filed against the CALLER, not the body', async () => {
  const r = await call('POST', '/api/carriage/apply', {
    headers: OP,
    body: {
      principal: 'kax:agent:somebody-else',
      label: 'Test Partner',
      kind: 'feed',
      template: 'card',
      feedUrl: 'https://example.com/feed.json',
      dayparts: ['prime'],
    },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.grant.principal, 'tv:operator:nick', 'a body principal was honoured');
  assert.strictEqual(r.json.grant.status, 'pending', 'carriage went live without approval');
});

test('an approved grant is not live until an operator says so', async () => {
  const pending = await call('GET', '/api/admin/carriage?status=pending', { headers: OP });
  assert.ok(pending.json.grants.length >= 1);
  const g = pending.json.grants[0];

  const approved = await call('POST', `/api/admin/carriage/${g.grantId}/approve`, { headers: OP, body: {} });
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.json.grant.status, 'active');

  const suspended = await call('POST', `/api/admin/carriage/${g.grantId}/suspend`, { headers: OP, body: { reason: 'testing' } });
  assert.strictEqual(suspended.json.grant.status, 'suspended');
  assert.strictEqual(suspended.json.grant.statusReason, 'testing');
});

test('a malformed application is refused with the reason, not a 500', async () => {
  const r = await call('POST', '/api/carriage/apply', {
    headers: OP,
    body: { label: 'Bad', kind: 'feed', template: 'card', feedUrl: 'http://insecure.example.com/f', dayparts: ['prime'] },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'feed_url_invalid');
});

test('admin routes refuse a non-operator', async () => {
  for (const p of ['/api/admin/carriage', '/api/admin/airlog', '/api/admin/outbox']) {
    const r = await call('GET', p);
    assert.strictEqual(r.status, 401, `${p} was open`);
    assert.strictEqual(r.json.error, 'operator_only');
  }
  const post = await call('POST', '/api/admin/rebuild', { body: {} });
  assert.strictEqual(post.status, 401);
});

// ----------------------------------------------------------------- the tower

test('the tower event receiver is inert until the office has a lease', async () => {
  const r = await call('POST', '/api/tower/events', { body: { kind: 'chat.said' } });
  assert.strictEqual(r.status, 503, 'an unconfigured receiver accepted an event');
  assert.strictEqual(r.json.error, 'not_configured');
});

// ------------------------------------------------------------------- hygiene

test('a body that is not a JSON object is refused', async () => {
  const r = await call('POST', '/api/auth/session', { headers: OP, body: '[1,2,3]' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'bad_json');
});

test('an oversized body is refused before it is read', async () => {
  const r = await call('POST', '/api/carriage/apply', { headers: OP, body: 'x'.repeat(80 * 1024) });
  assert.strictEqual(r.status, 413);
});

test('every JSON response forbids sniffing and caching', async () => {
  const r = await call('GET', '/api/now');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
});

test('an unknown route is a 404, not a crash', async () => {
  const r = await call('GET', '/api/nothing-here');
  assert.strictEqual(r.status, 404);
  const r2 = await call('DELETE', '/api/now');
  assert.strictEqual(r2.status, 404);
});
