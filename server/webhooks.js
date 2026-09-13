'use strict';
// Air reports. A broadcaster that cannot tell you that you aired is not a broadcaster.
//
// Same scheme as the tower's tenant feed, deliberately, so a partner who already receives tower
// events needs no new code: `X-Tower-Signature: sha256=<hmac of the exact body>`, a durable outbox,
// backoff from one minute to one hour, eight attempts, and delivery over the SSRF-vetted client so
// a partner URL cannot be used to reach inside the box.

const crypto = require('node:crypto');
const https = require('node:https');
const db = require('./db');
const config = require('./config');
const { vettingLookup, assertHostAllowed, FeedError } = require('./fetch-safe');

const BACKOFF_S = [60, 120, 300, 600, 1200, 2400, 3600, 3600];

function nowIso() {
  return new Date().toISOString();
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Queue an air report for a carried segment. Called once, at transmission, and only when the air
 * log actually recorded a new row — so a partner is never told they aired twice.
 */
async function enqueueAirReport(segment) {
  if (!config.webhooks.enabled) return;
  if (!segment || !segment.carriage) return;
  const grantId = segment.carriage.grantId;
  const row = await db.get('SELECT webhook_url FROM carriage WHERE grant_id = ?', [grantId]);
  if (!row || !row.webhook_url) return;

  const body = JSON.stringify({
    kind: 'segment.aired',
    id: segment.id,
    grantId,
    principal: segment.carriage.principal,
    label: segment.carriage.label,
    title: segment.title,
    subtitle: segment.subtitle || '',
    format: segment.formatId,
    daypart: segment.daypart,
    startsAt: segment.startsAt,
    duration: segment.duration,
    channel: config.publicUrl,
    sentAt: Date.now(),
  });

  await db.run(
    `INSERT OR IGNORE INTO outbox (id, grant_id, kind, body_json, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?)`,
    ['air_' + segment.id, grantId, 'segment.aired', body, Date.now(), nowIso()]
  );
}

/** Deliver one event. Resolves to {ok} or {ok:false, error} — never throws. */
function deliver(url, secret, body) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, error: 'bad_url', permanent: true });
    }
    if (u.protocol !== 'https:') return resolve({ ok: false, error: 'https_required', permanent: true });
    // An IP literal never reaches the lookup hook; vet it here or it is not vetted at all.
    try {
      assertHostAllowed(u.hostname);
    } catch (e) {
      return resolve({ ok: false, error: e.code, permanent: true });
    }

    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'user-agent': 'KannakaTV/1.0',
    };
    if (secret) headers['x-tower-signature'] = sign(secret, body);

    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        lookup: vettingLookup, // resolve-then-connect on the same addresses; no rebind window
        headers,
        timeout: 8000,
      },
      (res) => {
        res.resume(); // drain, we do not care what they say back
        const code = res.statusCode;
        if (code >= 200 && code < 300) return resolve({ ok: true });
        // A 4xx that is not a rate limit will not become a 2xx on retry.
        const permanent = code >= 400 && code < 500 && code !== 408 && code !== 429;
        resolve({ ok: false, error: 'status ' + code, permanent });
      }
    );
    req.on('timeout', () => req.destroy(new FeedError('timeout', 'no response in 8000ms')));
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.code) || (e && e.message) || e) }));
    req.write(body);
    req.end();
  });
}

async function sweep() {
  if (!config.webhooks.enabled) return { sent: 0 };
  const due = await db.all(
    `SELECT o.*, c.webhook_url, c.webhook_secret
       FROM outbox o JOIN carriage c ON c.grant_id = o.grant_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= ?
      ORDER BY o.next_attempt_at ASC LIMIT ?`,
    [Date.now(), config.webhooks.batch]
  );

  let sent = 0;
  for (const ev of due) {
    if (!ev.webhook_url) {
      await db.run(`UPDATE outbox SET status='failed', last_error=? WHERE id = ?`, ['no_webhook_url', ev.id]);
      continue;
    }
    const res = await deliver(ev.webhook_url, ev.webhook_secret, ev.body_json);
    const attempts = ev.attempts + 1;
    if (res.ok) {
      await db.run(`UPDATE outbox SET status='delivered', attempts=?, delivered_at=?, last_error=NULL WHERE id = ?`, [
        attempts,
        nowIso(),
        ev.id,
      ]);
      sent++;
    } else if (res.permanent || attempts >= config.webhooks.maxAttempts) {
      await db.run(`UPDATE outbox SET status='failed', attempts=?, last_error=? WHERE id = ?`, [attempts, res.error, ev.id]);
    } else {
      const wait = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000;
      await db.run(`UPDATE outbox SET attempts=?, next_attempt_at=?, last_error=? WHERE id = ?`, [
        attempts,
        Date.now() + wait,
        res.error,
        ev.id,
      ]);
    }
  }
  return { sent, considered: due.length };
}

/** Delivered and failed events older than a week are not evidence of anything. */
async function prune() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await db.run(`DELETE FROM outbox WHERE status IN ('delivered','failed') AND created_at < ?`, [cutoff]);
  return r.changes;
}

let timer = null;
let pruneTimer = null;

function start() {
  const tick = () => sweep().catch(() => {});
  tick();
  timer = setInterval(tick, Math.max(10, config.webhooks.sweepSeconds) * 1000);
  timer.unref?.();
  pruneTimer = setInterval(() => prune().catch(() => {}), 3600 * 1000);
  pruneTimer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  if (pruneTimer) clearInterval(pruneTimer);
  timer = null;
  pruneTimer = null;
}

module.exports = { enqueueAirReport, sweep, prune, deliver, sign, start, stop, BACKOFF_S };
