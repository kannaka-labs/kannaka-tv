'use strict';
// Every knob in one place, with the studio's rule: a missing secret makes a feature inert
// (refused, or skipped) rather than crashing the transmitter. The channel stays on air.
const path = require('node:path');
const os = require('node:os');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => {
  const n = parseInt(env(k, ''), 10);
  return Number.isFinite(n) ? n : d;
};

module.exports = {
  port: int('TV_PORT', 8891),
  bind: env('TV_BIND', '127.0.0.1'),
  publicUrl: env('TV_PUBLIC_URL', 'https://tv.ninja-portal.com').replace(/\/+$/, ''),
  dataDir: env('TV_DATA_DIR', path.join(os.homedir(), '.kannaka-tv')),
  adminToken: env('TV_ADMIN_TOKEN', ''),

  // How far ahead the transmitter plans, and how often it extends the horizon. The horizon must
  // comfortably outlive the rebuild interval or a viewer can outrun the schedule.
  horizonMinutes: int('TV_HORIZON_MINUTES', 360),
  rebuildSeconds: int('TV_REBUILD_SECONDS', 120),
  // Segments older than this are dropped from memory; the air log keeps the record.
  keepPastMinutes: int('TV_KEEP_PAST_MINUTES', 120),

  // Third-party feeds
  feed: {
    refreshSeconds: int('TV_FEED_REFRESH_SECONDS', 300),
    maxBytes: int('TV_FEED_MAX_BYTES', 256 * 1024),
    timeoutMs: int('TV_FEED_TIMEOUT_MS', 8000),
    // A feed that has failed this many times running is suspended and the operator is told.
    failuresBeforeSuspend: int('TV_FEED_FAILURES_BEFORE_SUSPEND', 12),
  },

  // Air reports to carriage partners. Same signature scheme and backoff as the tower.
  webhooks: {
    enabled: env('TV_WEBHOOKS', 'on') !== 'off',
    batch: int('TV_WEBHOOK_BATCH', 20),
    maxAttempts: int('TV_WEBHOOK_MAX_ATTEMPTS', 8),
    sweepSeconds: int('TV_WEBHOOK_SWEEP_SECONDS', 30),
  },

  // The office on floor 11. Inert until a lease exists, exactly as the record studio's was.
  tower: {
    base: env('TV_KAX_BASE', 'https://kax.ninja-portal.com'),
    storey: int('KAX_TOWER_STOREY', 0),
    credential: env('KAX_TOWER_CREDENTIAL', ''),
    webhookSecret: env('TOWER_WEBHOOK_SECRET', ''),
    agentToken: env('KAX_AGENT_TOKEN', ''),
    panelSeconds: int('TV_PANEL_SECONDS', 300),
  },

  // Identity providers we will accept a proof from (ADR-0001 decision 4).
  auth: {
    kaxBase: env('TV_KAX_BASE', 'https://kax.ninja-portal.com'),
    obcBase: env('TV_OBC_BASE', 'https://api.openbotcity.ai'),
    portalBase: env('TV_PORTAL_BASE', 'https://ninja-portal.com'),
    spacechildBase: env('TV_SPACECHILD_BASE', 'https://auth.spacechild.love'),
    sessionHours: int('TV_SESSION_HOURS', 72),
  },

  // OpenBotCity, for the gallery format. Without a token the format is simply dark and the
  // rotation steps over it — the channel does not care.
  obc: {
    base: env('TV_OBC_BASE', 'https://api.openbotcity.com'),
    jwt: env('OPENBOTCITY_JWT', ''),
  },

  env: env('TV_ENV', 'production'),
};
