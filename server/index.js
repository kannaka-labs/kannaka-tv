'use strict';
// Kannaka TV — the transmitter's public face.
//
// Two tracks off one schedule: /api/* is the agent track, /public is the human one. Both read the
// same segments from the same clock.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const carriage = require('./carriage');
const core = require('./carriage-core');
const transmitter = require('./transmitter');
const webhooks = require('./webhooks');
const tower = require('./tower');
const features = require('./features');
const sources = require('./sources');
const sc = require('./schedule-core');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, error: code, message: message || code });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      return reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
    }
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY) {
        req.destroy();
        return reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    const v = JSON.parse(raw.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw Object.assign(new Error('body must be a JSON object'), { code: 'bad_json' });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(res, rel) {
  // Resolve and then confirm the result is still inside the public directory — a check on the
  // input string alone is the classic traversal hole.
  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not_found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ---- The broadcast: the agent track -------------------------------------
  if (p === '/api/now' && method === 'GET') {
    const at = Number(url.searchParams.get('at')) || undefined;
    return send(res, 200, transmitter.nowPayload(at));
  }

  if (p === '/api/guide' && method === 'GET') {
    const hours = Math.max(1, Math.min(12, Number(url.searchParams.get('hours')) || 3));
    return send(res, 200, {
      ok: true,
      serverNow: Date.now(),
      hours,
      dayparts: sc.DAYPARTS.map((d) => ({ key: d.key, label: d.label, start: d.start, end: d.end, mood: d.mood })),
      segments: transmitter.guide(Date.now(), hours),
    });
  }

  if (p.startsWith('/api/segment/') && method === 'GET') {
    const seg = transmitter.segmentById(decodeURIComponent(p.slice('/api/segment/'.length)));
    if (!seg) return fail(res, 404, 'not_found', 'no segment with that id is in the current schedule');
    return send(res, 200, { ok: true, segment: seg });
  }

  if (p === '/api/health' && method === 'GET') {
    const st = transmitter.status();
    return send(res, 200, {
      ok: true,
      channel: 'Kannaka TV',
      onAir: st.onAir,
      segments: st.segments,
      horizonSeconds: st.horizonSeconds,
      rebuilds: st.rebuilds,
      lastError: st.lastError,
      tower: tower.status(),
      features: features.list().length,
      music: features.music().length,
      auth: auth.providers(),
      serverNow: st.serverNow,
    });
  }

  if (p === '/api/status' && method === 'GET') {
    const [feedSt, grants] = await Promise.all([carriage.feedStatus(), carriage.listGrants()]);
    return send(res, 200, {
      ok: true,
      transmitter: transmitter.status(),
      tower: tower.status(),
      carriage: {
        active: grants.filter((g) => g.status === 'active').length,
        pending: grants.filter((g) => g.status === 'pending').length,
        suspended: grants.filter((g) => g.status === 'suspended').length,
        feeds: feedSt,
      },
    });
  }

  if (p === '/api/sources' && method === 'GET') {
    // What the channel can currently see. Useful to a person and to an agent deciding whether a
    // dark segment is our fault or theirs.
    const snap = await sources.snapshot();
    const seen = {};
    for (const [k, v] of Object.entries(snap)) {
      if (k === 'at') continue;
      seen[k] = v && v.ok ? { ok: true } : { ok: false, reason: (v && v.reason) || 'unknown' };
    }
    return send(res, 200, { ok: true, sources: seen, at: snap.at });
  }

  if (p === '/api/formats' && method === 'GET') {
    const { FORMAT_META } = require('./formats');
    return send(res, 200, {
      ok: true,
      formats: Object.entries(FORMAT_META).map(([id, m]) => ({ id, ...m })),
      feedTemplates: core.FEED_TEMPLATES,
      // The wire formats a feed may speak. `rss` lets a feed that already exists anywhere be
      // carried without its author writing anything for us.
      feedWireFormats: core.FEED_WIRE_FORMATS,
      referenceProviders: Object.fromEntries(
        Object.entries(core.REFERENCE_PROVIDERS).map(([k, v]) => [k, { label: v.label }])
      ),
      dayparts: sc.DAYPARTS.map((d) => ({ key: d.key, label: d.label, start: d.start, end: d.end, mood: d.mood })),
      imageHosts: core.IMAGE_HOSTS,
    });
  }

  // ---- Identity -----------------------------------------------------------
  if (p === '/api/auth/providers' && method === 'GET') {
    return send(res, 200, { ok: true, ...auth.providers() });
  }

  if (p === '/api/auth/session' && method === 'POST') {
    const body = await readJson(req);
    try {
      const s = await auth.signIn(body.system, body.proof || body.token);
      return send(res, 200, {
        ok: true,
        token: s.token,
        principal: s.principal,
        system: s.system,
        display: s.display,
        expiresAt: s.expiresAt,
      });
    } catch (e) {
      if (e instanceof auth.AuthError) {
        const status = e.code === 'proof_rejected' ? 401 : e.code === 'provider_error' ? 502 : 400;
        return fail(res, status, e.code, e.message);
      }
      throw e;
    }
  }

  if (p === '/api/auth/session' && method === 'DELETE') {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const n = m ? await auth.signOut(m[1].trim()) : 0;
    return send(res, 200, { ok: true, ended: n });
  }

  if (p === '/api/auth/me' && method === 'GET') {
    const id = await auth.identify(req);
    if (!id) return fail(res, 401, 'not_signed_in');
    return send(res, 200, { ok: true, ...id });
  }

  // ---- Carriage -----------------------------------------------------------
  if (p === '/api/carriage/apply' && method === 'POST') {
    const id = await auth.identify(req);
    if (!id) return fail(res, 401, 'not_signed_in', 'sign in with a proof from one of the systems first');
    const body = await readJson(req);
    try {
      const grant = await carriage.apply(body, id);
      return send(res, 201, {
        ok: true,
        grant,
        message: 'Filed. The operator reviews carriage applications; you will be told when it is decided.',
      });
    } catch (e) {
      if (e instanceof core.CarriageError) return fail(res, 400, e.code, e.message);
      throw e;
    }
  }

  if (p === '/api/carriage/mine' && method === 'GET') {
    const id = await auth.identify(req);
    if (!id) return fail(res, 401, 'not_signed_in');
    const grants = await carriage.listForPrincipal(id.principal);
    const feedSt = await carriage.feedStatus();
    return send(res, 200, {
      ok: true,
      grants: grants.map((g) => ({ ...g, feed: feedSt[g.grantId] || null })),
    });
  }

  if (p === '/api/carriage/airings' && method === 'GET') {
    const id = await auth.identify(req);
    if (!id) return fail(res, 401, 'not_signed_in');
    const rows = await db.all(
      `SELECT segment_id, format_id, title, subtitle, daypart, grant_id, starts_at, duration
         FROM airlog WHERE principal = ? ORDER BY starts_at DESC LIMIT 100`,
      [id.principal]
    );
    return send(res, 200, { ok: true, airings: rows });
  }

  // ---- The operator -------------------------------------------------------
  if (p.startsWith('/api/admin/')) {
    const id = await auth.identify(req);
    if (!auth.isOperator(id)) return fail(res, 401, 'operator_only');

    if (p === '/api/admin/carriage' && method === 'GET') {
      const grants = await carriage.listGrants(url.searchParams.get('status') || undefined);
      const feedSt = await carriage.feedStatus();
      return send(res, 200, { ok: true, grants: grants.map((g) => ({ ...g, feed: feedSt[g.grantId] || null })) });
    }

    const decide = p.match(/^\/api\/admin\/carriage\/([A-Za-z0-9_-]+)\/(approve|decline|suspend|resume|end|refresh)$/);
    if (decide && method === 'POST') {
      const [, grantId, action] = decide;
      const body = await readJson(req).catch(() => ({}));
      try {
        if (action === 'approve') {
          const { grant, secret } = await carriage.approve(grantId);
          // Fetch their feed before replanning, or the first slot finds nothing to carry.
          if (grant) await carriage.refreshOne(grant);
          const replan = await transmitter.replanTail('carriage approved');
          return send(res, 200, {
            ok: true,
            grant,
            webhookSecret: secret,
            replan,
            note: secret ? 'This signing secret is shown once. Store it now.' : undefined,
          });
        }
        if (action === 'decline') return send(res, 200, { ok: true, grant: await carriage.decline(grantId, body.reason) });
        if (action === 'suspend') {
          const grant = await carriage.suspend(grantId, body.reason);
          return send(res, 200, { ok: true, grant, replan: await transmitter.replanTail('carriage suspended') });
        }
        if (action === 'resume') {
          const grant = await carriage.resume(grantId);
          if (grant) await carriage.refreshOne(grant);
          return send(res, 200, { ok: true, grant, replan: await transmitter.replanTail('carriage resumed') });
        }
        if (action === 'end') {
          const grant = await carriage.end(grantId);
          return send(res, 200, { ok: true, grant, replan: await transmitter.replanTail('carriage ended') });
        }
        if (action === 'refresh') {
          const g = await carriage.getGrant(grantId);
          if (!g) return fail(res, 404, 'not_found');
          return send(res, 200, { ok: true, result: await carriage.refreshOne(g) });
        }
      } catch (e) {
        if (e instanceof core.CarriageError) return fail(res, 400, e.code, e.message);
        throw e;
      }
    }

    if (p === '/api/admin/rebuild' && method === 'POST') {
      sources.clearCache();
      return send(res, 200, { ok: true, result: await transmitter.rebuild() });
    }

    if (p === '/api/admin/features/reload' && method === 'POST') {
      const n = features.reload();
      // Reloading the slate is a programming change, so it replans the tail like any other —
      // otherwise a new feature waits out the whole committed horizon before it can air.
      return send(res, 200, { ok: true, ...n, replan: await transmitter.replanTail('slate reloaded') });
    }

    if (p === '/api/admin/panel' && method === 'POST') {
      return send(res, 200, { ok: true, result: await tower.writePanel(transmitter.nowPayload()) });
    }

    if (p === '/api/admin/airlog' && method === 'GET') {
      const rows = await db.all('SELECT * FROM airlog ORDER BY starts_at DESC LIMIT 200');
      return send(res, 200, { ok: true, airlog: rows });
    }

    if (p === '/api/admin/outbox' && method === 'GET') {
      const rows = await db.all('SELECT id, grant_id, kind, attempts, status, last_error, next_attempt_at FROM outbox ORDER BY created_at DESC LIMIT 100');
      return send(res, 200, { ok: true, outbox: rows });
    }

    return fail(res, 404, 'not_found');
  }

  // ---- Inbound from the tower --------------------------------------------
  if (p === '/api/tower/events' && method === 'POST') {
    if (!config.tower.webhookSecret) return fail(res, 503, 'not_configured', 'the office has no lease yet');
    const raw = await readBody(req);
    const v = tower.verifySignature(raw, req.headers['x-tower-signature']);
    if (!v.ok) return fail(res, 401, v.reason);
    let ev = null;
    try {
      ev = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail(res, 400, 'bad_json');
    }
    // Tolerate kinds we do not know; the tower may add more and a 4xx would retry forever.
    return send(res, 200, { ok: true, received: ev && ev.kind ? ev.kind : 'unknown' });
  }

  // ---- The human track ----------------------------------------------------
  if (method === 'GET' || method === 'HEAD') {
    if (p === '/' || p === '/watch') return serveStatic(res, 'index.html');
    if (p === '/guide') return serveStatic(res, 'guide.html');
    if (p === '/carriage') return serveStatic(res, 'carriage.html');
    if (p === '/robots.txt') {
      return send(res, 200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (!p.startsWith('/api/')) return serveStatic(res, p);
  }

  return fail(res, 404, 'not_found');
}

// ---------------------------------------------------------------------------

/**
 * The whole request path, error mapping included. The server and the tests both go through this,
 * so a test can never be exercising a different mapping from the one that ships.
 */
function handleRequest(req, res, url) {
  return route(req, res, url).catch((e) => {
    const code = e && e.code;
    if (code === 'too_large') return fail(res, 413, 'too_large');
    if (code === 'bad_json') return fail(res, 400, 'bad_json', e.message);
    if (config.env !== 'production' && config.env !== 'test') console.error('[tv]', e);
    fail(res, 500, 'server_error');
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail(res, 400, 'bad_request');
  }
  handleRequest(req, res, url);
});

async function main() {
  await db.init();
  await auth.pruneSessions();
  await transmitter.start();
  webhooks.start();
  tower.start(() => transmitter.nowPayload());

  server.listen(config.port, config.bind, () => {
    const st = transmitter.status();
    console.log(`[tv] Kannaka TV on ${config.bind}:${config.port} — ${st.segments} segments planned, ${Math.round(st.horizonSeconds / 60)}m of horizon`);
    console.log(`[tv] office: ${tower.configured() ? 'floor ' + config.tower.storey : 'no lease yet'} | features: ${features.list().length}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[tv] failed to start:', e);
    process.exit(1);
  });
}

module.exports = { server, route, handleRequest, main };
