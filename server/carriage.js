'use strict';
// Carriage, persisted: applications, grants, the feed refresher and the daily airing counts the
// planner reads. The rules live in carriage-core.js; this file only stores and fetches.

const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const core = require('./carriage-core');
const { fetchJson, FeedError } = require('./fetch-safe');

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return prefix + crypto.randomBytes(9).toString('base64url');
}

function rowToGrant(r) {
  if (!r) return null;
  return {
    grantId: r.grant_id,
    principal: r.principal,
    system: r.system,
    label: r.label,
    about: r.about || '',
    kind: r.kind,
    template: r.template,
    feedUrl: r.feed_url,
    provider: r.provider,
    ref: r.ref,
    duration: r.duration,
    dayparts: safeParse(r.dayparts_json, []),
    maxPerDay: r.max_per_day,
    contact: r.contact || '',
    webhookUrl: r.webhook_url || null,
    hasWebhookSecret: Boolean(r.webhook_secret),
    status: r.status,
    statusReason: r.status_reason || null,
    appliedAt: r.applied_at,
    decidedAt: r.decided_at,
  };
}

function safeParse(s, dflt) {
  try {
    const v = JSON.parse(s);
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
}

// ---------------------------------------------------------------------------
// Applying and deciding
// ---------------------------------------------------------------------------

async function apply(body, identity) {
  const rec = core.validateApplication(body, identity.principal);
  const grantId = newId('car_');
  await db.run(
    `INSERT INTO carriage
       (grant_id, principal, system, label, about, kind, template, feed_url, provider, ref,
        duration, dayparts_json, max_per_day, contact, webhook_url, status, applied_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      grantId,
      rec.principal,
      identity.system,
      rec.label,
      rec.about,
      rec.kind,
      rec.template,
      rec.feedUrl,
      rec.provider,
      rec.ref,
      rec.duration,
      JSON.stringify(rec.dayparts),
      rec.maxPerDay,
      rec.contact,
      rec.webhookUrl,
      'pending',
      nowIso(),
      nowIso(),
    ]
  );
  return getGrant(grantId);
}

async function getGrant(grantId) {
  return rowToGrant(await db.get('SELECT * FROM carriage WHERE grant_id = ?', [grantId]));
}

async function listGrants(status) {
  const rows = status
    ? await db.all('SELECT * FROM carriage WHERE status = ? ORDER BY applied_at DESC', [status])
    : await db.all('SELECT * FROM carriage ORDER BY applied_at DESC');
  return rows.map(rowToGrant);
}

async function listForPrincipal(principal) {
  const rows = await db.all('SELECT * FROM carriage WHERE principal = ? ORDER BY applied_at DESC', [principal]);
  return rows.map(rowToGrant);
}

/**
 * Approve an application. Mints the webhook signing secret and returns it ONCE — it is stored
 * hashed nowhere, because we need the raw value to sign with, but it is never served again.
 */
async function approve(grantId) {
  const g = await getGrant(grantId);
  if (!g) throw new core.CarriageError('not_found', 'no such application');
  if (g.status === 'active') return { grant: g, secret: null };
  const secret = g.webhookUrl ? crypto.randomBytes(24).toString('base64url') : null;
  await db.run(
    `UPDATE carriage SET status='active', status_reason=NULL, decided_at=?, updated_at=?,
       webhook_secret = COALESCE(?, webhook_secret) WHERE grant_id = ?`,
    [nowIso(), nowIso(), secret, grantId]
  );
  return { grant: await getGrant(grantId), secret };
}

async function decline(grantId, reason) {
  await db.run(`UPDATE carriage SET status='declined', status_reason=?, decided_at=?, updated_at=? WHERE grant_id = ?`, [
    core.clean(reason, 200) || 'declined',
    nowIso(),
    nowIso(),
    grantId,
  ]);
  return getGrant(grantId);
}

/** Take a grant off air without ending it. The tower calls this "dark" and so do we. */
async function suspend(grantId, reason) {
  await db.run(`UPDATE carriage SET status='suspended', status_reason=?, updated_at=? WHERE grant_id = ?`, [
    core.clean(reason, 200) || 'suspended',
    nowIso(),
    grantId,
  ]);
  return getGrant(grantId);
}

async function resume(grantId) {
  await db.run(`UPDATE carriage SET status='active', status_reason=NULL, updated_at=? WHERE grant_id = ?`, [nowIso(), grantId]);
  await db.run(`UPDATE feed_cache SET consecutive_failures = 0 WHERE grant_id = ?`, [grantId]);
  return getGrant(grantId);
}

async function end(grantId) {
  await db.run(`UPDATE carriage SET status='ended', decided_at=?, updated_at=? WHERE grant_id = ?`, [nowIso(), nowIso(), grantId]);
  return getGrant(grantId);
}

async function secretFor(grantId) {
  const r = await db.get('SELECT webhook_secret FROM carriage WHERE grant_id = ?', [grantId]);
  return r ? r.webhook_secret : null;
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/**
 * Refresh one grant's payload. Never throws: a feed that fails is recorded dark and the format
 * simply has nothing to offer this cycle.
 */
async function refreshOne(grant) {
  if (grant.kind === 'reference') {
    const payload = core.shapeReferencePayload(grant);
    await db.run(
      `INSERT INTO feed_cache (grant_id, payload_json, fetched_at, ok, reason, consecutive_failures)
       VALUES (?,?,?,1,NULL,0)
       ON CONFLICT(grant_id) DO UPDATE SET payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at, ok=1, reason=NULL, consecutive_failures=0`,
      [grant.grantId, JSON.stringify(payload), nowIso()]
    );
    return { ok: true, payload };
  }

  try {
    const raw = await fetchJson(grant.feedUrl, {
      maxBytes: config.feed.maxBytes,
      timeoutMs: config.feed.timeoutMs,
    });
    const payload = core.shapeFeedPayload(grant.template, raw);
    await db.run(
      `INSERT INTO feed_cache (grant_id, payload_json, fetched_at, ok, reason, consecutive_failures)
       VALUES (?,?,?,1,NULL,0)
       ON CONFLICT(grant_id) DO UPDATE SET payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at, ok=1, reason=NULL, consecutive_failures=0`,
      [grant.grantId, JSON.stringify(payload), nowIso()]
    );
    return { ok: true, payload };
  } catch (e) {
    const reason = e instanceof FeedError || e instanceof core.CarriageError ? e.code : 'refresh_failed';
    const row = await db.get('SELECT consecutive_failures FROM feed_cache WHERE grant_id = ?', [grant.grantId]);
    const fails = ((row && row.consecutive_failures) || 0) + 1;
    await db.run(
      `INSERT INTO feed_cache (grant_id, payload_json, fetched_at, ok, reason, consecutive_failures)
       VALUES (?,NULL,?,0,?,?)
       ON CONFLICT(grant_id) DO UPDATE SET fetched_at=excluded.fetched_at, ok=0,
         reason=excluded.reason, consecutive_failures=excluded.consecutive_failures`,
      [grant.grantId, nowIso(), reason, fails]
    );
    if (fails >= config.feed.failuresBeforeSuspend && grant.status === 'active') {
      await suspend(grant.grantId, `feed dark: ${reason} (${fails} consecutive failures)`);
    }
    return { ok: false, reason, failures: fails };
  }
}

async function refreshAll() {
  const grants = await listGrants('active');
  const results = [];
  for (const g of grants) {
    results.push({ grantId: g.grantId, ...(await refreshOne(g)) });
  }
  return results;
}

/** The cached payloads the planner may use, keyed by grant id. Dark feeds are simply absent. */
async function payloads() {
  const rows = await db.all('SELECT grant_id, payload_json, ok FROM feed_cache WHERE ok = 1');
  const out = {};
  for (const r of rows) {
    const p = safeParse(r.payload_json, null);
    if (p) out[r.grant_id] = p;
  }
  return out;
}

async function feedStatus() {
  const rows = await db.all('SELECT * FROM feed_cache');
  const out = {};
  for (const r of rows) {
    out[r.grant_id] = {
      ok: Boolean(r.ok),
      reason: r.reason || null,
      fetchedAt: r.fetched_at,
      consecutiveFailures: r.consecutive_failures,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Airing counts — what the eligibility rule reads
// ---------------------------------------------------------------------------

/**
 * How many times each grant has aired in the broadcast day containing `at`.
 * The broadcast day runs midnight to midnight in Chicago, matching the daypart grid.
 */
async function airedToday(at) {
  const start = chicagoMidnight(at || Date.now());
  const rows = await db.all(
    'SELECT grant_id, COUNT(*) AS n FROM airlog WHERE grant_id IS NOT NULL AND starts_at >= ? GROUP BY grant_id',
    [start]
  );
  const out = {};
  for (const r of rows) out[r.grant_id] = r.n;
  return out;
}

function chicagoMidnight(ms) {
  // Find the UTC instant of the most recent Chicago midnight by asking Intl what the local date is
  // and walking back the hours/minutes/seconds it reports.
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t) => Number((p.find((x) => x.type === t) || {}).value || 0);
    const h = get('hour') % 24;
    const m = get('minute');
    const s = get('second');
    return ms - ((h * 3600 + m * 60 + s) * 1000 + (ms % 1000));
  } catch {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
}

module.exports = {
  apply,
  getGrant,
  listGrants,
  listForPrincipal,
  approve,
  decline,
  suspend,
  resume,
  end,
  secretFor,
  refreshOne,
  refreshAll,
  payloads,
  feedStatus,
  airedToday,
  chicagoMidnight,
};
