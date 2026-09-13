'use strict';
// One desk, many proofs (ADR-0001 decision 4).
//
// The systems do not share an identity provider and Kannaka TV does not try to build one. It takes
// a proof from a system it recognises, verifies that proof WITH THAT SYSTEM, and mints its own
// short-lived session. A principal is always derived from what the upstream system says — never
// from a name the caller supplies.

const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

const TIMEOUT_MS = 10_000;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function upstream(url, token, extraHeaders) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/json',
        'user-agent': 'KannakaTV/1.0',
        ...(extraHeaders || {}),
      },
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Providers. Each returns { principal, system, display } or throws AuthError.
// ---------------------------------------------------------------------------

const PROVIDERS = {
  /** A KAX City agent token. Verified against the city's own /api/agents/me. */
  async kax(token) {
    const r = await upstream(config.auth.kaxBase + '/api/agents/me', token);
    if (r.status === 401 || r.status === 403) throw new AuthError('proof_rejected', 'KAX did not recognise that token');
    if (r.status !== 200 || !r.json) throw new AuthError('provider_error', 'KAX answered ' + r.status);
    const a = r.json.agent || r.json;
    const id = a.id || a.agentId || a.agent_id;
    if (!id) throw new AuthError('provider_error', 'KAX returned no agent id');
    return { principal: `kax:agent:${id}`, system: 'kax', display: a.displayName || a.name || a.handle || String(id) };
  },

  /** An OpenBotCity bot JWT. Verified by asking OBC who the bearer is. */
  async obc(token) {
    const r = await upstream('https://api.openbotcity.com/agents/me', token);
    if (r.status === 401 || r.status === 403) throw new AuthError('proof_rejected', 'OpenBotCity did not recognise that token');
    if (r.status !== 200 || !r.json) throw new AuthError('provider_error', 'OpenBotCity answered ' + r.status);
    const a = (r.json && (r.json.agent || r.json.bot || r.json.data)) || r.json;
    const id = a.id || a.bot_id || a.botId || a.agent_id;
    if (!id) throw new AuthError('provider_error', 'OpenBotCity returned no bot id');
    return { principal: `obc:bot:${id}`, system: 'obc', display: a.name || a.username || a.handle || String(id) };
  },

  /**
   * A Constellation Pass key. The portal's gateway will answer /v1/models for a live key and
   * refuse a dead one, which proves the holder without the portal having to expose an identity
   * route. The principal is a stable digest of the key, so a pass holder is pseudonymous but
   * consistent across sessions — and we never store the key itself.
   */
  async portal(token) {
    if (!/^sk-/.test(token)) throw new AuthError('proof_malformed', 'a Constellation Pass key starts with sk-');
    const r = await upstream(config.auth.portalBase + '/v1/models', token);
    if (r.status === 401 || r.status === 403) throw new AuthError('proof_rejected', 'the portal did not recognise that key');
    if (r.status !== 200) throw new AuthError('provider_error', 'the portal answered ' + r.status);
    return { principal: `portal:pass:${sha256(token).slice(0, 24)}`, system: 'portal', display: 'Constellation Pass holder' };
  },

  /**
   * The operator. Not a system identity — the one admin, as in the tower.
   * Inert when no token is configured, rather than open.
   */
  async operator(token) {
    if (!config.adminToken) throw new AuthError('provider_unavailable', 'no operator token is configured');
    if (!safeEqual(token, config.adminToken)) throw new AuthError('proof_rejected', 'not the operator token');
    return { principal: 'tv:operator:nick', system: 'tv', display: 'Operator' };
  },
};

// Providers named in the ADR that do not yet have a verification path. They are listed rather than
// hidden, and they refuse rather than pretend.
const PLANNED = {
  spacechild: 'SpaceChild SSO is not wired yet',
  swarm: 'NATS-credentialed swarm identity is not wired yet',
  email: 'email claim is not wired yet',
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Verify a proof and mint a session token. The token is returned once and stored only hashed. */
async function signIn(system, token) {
  const key = String(system || '').toLowerCase();
  if (PLANNED[key]) throw new AuthError('provider_unavailable', PLANNED[key]);
  const provider = PROVIDERS[key];
  if (!provider) throw new AuthError('provider_unknown', 'unknown system: ' + key);
  if (!token || typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    throw new AuthError('proof_malformed', 'a proof is required');
  }

  const identity = await provider(token);
  const raw = 'tv_' + crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + config.auth.sessionHours * 3600 * 1000;
  await db.run(
    `INSERT INTO sessions (token_hash, principal, system, display, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
    [sha256(raw), identity.principal, identity.system, identity.display || '', new Date().toISOString(), expiresAt]
  );
  return { token: raw, expiresAt, ...identity };
}

/** Resolve a session token to an identity, or null. Expiry is checked live, not at mint time. */
async function resolve(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const row = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(rawToken)]);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(rawToken)]);
    return null;
  }
  return { principal: row.principal, system: row.system, display: row.display || '', expiresAt: row.expires_at };
}

/**
 * Read the caller's identity from a request. A session token is the normal path; the operator
 * token is also accepted directly so an admin can act with curl.
 */
async function identify(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();

  if (config.adminToken && safeEqual(token, config.adminToken)) {
    return { principal: 'tv:operator:nick', system: 'tv', display: 'Operator', operator: true };
  }
  const s = await resolve(token);
  if (!s) return null;
  return { ...s, operator: s.principal === 'tv:operator:nick' };
}

function isOperator(identity) {
  return Boolean(identity && identity.operator);
}

async function signOut(rawToken) {
  if (!rawToken) return 0;
  const r = await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(rawToken)]);
  return r.changes;
}

async function pruneSessions() {
  const r = await db.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  return r.changes;
}

function providers() {
  return {
    available: Object.keys(PROVIDERS).filter((k) => k !== 'operator'),
    planned: PLANNED,
  };
}

module.exports = { signIn, signOut, resolve, identify, isOperator, pruneSessions, providers, AuthError, sha256, safeEqual };
