'use strict';
// SQLite, promisified, one file. The schema is created on open and every ALTER is guarded, so an
// older database upgrades in place rather than needing a migration runner.
const path = require('node:path');
const fs = require('node:fs');
const sqlite3 = require('sqlite3');
const config = require('./config');

const SCHEMA = [
  // A carriage application, and the grant it becomes. One row: the application IS the agreement
  // once approved, so there is never a pair to keep in step.
  `CREATE TABLE IF NOT EXISTS carriage (
     grant_id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     system TEXT NOT NULL,
     label TEXT NOT NULL,
     about TEXT,
     kind TEXT NOT NULL,
     template TEXT,
     feed_url TEXT,
     provider TEXT,
     ref TEXT,
     duration INTEGER NOT NULL,
     dayparts_json TEXT NOT NULL,
     max_per_day INTEGER NOT NULL,
     contact TEXT,
     webhook_url TEXT,
     webhook_secret TEXT,
     status TEXT NOT NULL,
     status_reason TEXT,
     applied_at TEXT NOT NULL,
     decided_at TEXT,
     updated_at TEXT NOT NULL
   )`,
  `ALTER TABLE carriage ADD COLUMN feed_format TEXT NOT NULL DEFAULT 'json'`,
  `CREATE INDEX IF NOT EXISTS carriage_status ON carriage(status)`,
  `CREATE INDEX IF NOT EXISTS carriage_principal ON carriage(principal)`,

  // The last good payload for each grant, plus why it is dark if it is. Cached so a slow or
  // flapping feed never blocks the planner.
  `CREATE TABLE IF NOT EXISTS feed_cache (
     grant_id TEXT PRIMARY KEY,
     payload_json TEXT,
     fetched_at TEXT,
     ok INTEGER NOT NULL DEFAULT 0,
     reason TEXT,
     consecutive_failures INTEGER NOT NULL DEFAULT 0
   )`,

  // What actually went out. Keyed on segment id, which is never reused (ADR-0001 decision 6).
  `CREATE TABLE IF NOT EXISTS airlog (
     segment_id TEXT PRIMARY KEY,
     format_id TEXT NOT NULL,
     title TEXT,
     subtitle TEXT,
     daypart TEXT,
     grant_id TEXT,
     principal TEXT,
     starts_at INTEGER NOT NULL,
     duration INTEGER NOT NULL,
     logged_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS airlog_start ON airlog(starts_at)`,
  `CREATE INDEX IF NOT EXISTS airlog_grant ON airlog(grant_id, starts_at)`,

  // Air reports waiting to go out, as a durable outbox with backoff.
  `CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY,
     grant_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     body_json TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     last_error TEXT,
     created_at TEXT NOT NULL,
     delivered_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at)`,

  // Viewer/holder sessions minted against a proof from one of the systems.
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     system TEXT NOT NULL,
     display TEXT,
     created_at TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal)`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`,
];

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'kannaka-tv.sqlite');
  db = new sqlite3.Database(file);
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    open().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function init() {
  open();
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA busy_timeout = 5000');
  for (const stmt of SCHEMA) {
    try {
      await run(stmt);
    } catch (e) {
      // A guarded ALTER on a column that already exists is the expected case on every restart.
      if (!/duplicate column name/i.test(String(e && e.message))) throw e;
    }
  }
}

function close() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => {
      db = null;
      resolve();
    });
  });
}

module.exports = { init, run, get, all, close, open };
