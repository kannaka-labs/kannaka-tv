'use strict';
// The long-form catalogue: programmes that already exist somewhere else and are carried by
// reference (ADR-0001 decision 2). Nothing here is stored by us; every entry is a pointer.
//
// Two files are read, in order: the one in the repo (the house slate, reviewed in a PR) and an
// optional operator file in the data directory, so a new episode can go on air without a deploy.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const REPO_FILE = path.join(__dirname, '..', 'data', 'features.json');
const OPERATOR_FILE = path.join(config.dataDir, 'features.json');

let cache = { at: 0, list: [] };
const TTL_MS = 60_000;

const YT = /^[A-Za-z0-9_-]{11}$/;

function readFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A missing or unparseable catalogue is not an error; Prime simply has nothing long-form and
    // the rotation steps over it.
    return [];
  }
}

function valid(f) {
  if (!f || typeof f !== 'object') return false;
  if (!f.id || !f.title || !f.ref) return false;
  const provider = f.provider || 'youtube';
  if (provider === 'youtube' && !YT.test(String(f.ref))) return false;
  return true;
}

function list() {
  const now = Date.now();
  if (now - cache.at < TTL_MS) return cache.list;
  const merged = [];
  const seen = new Set();
  for (const f of [...readFile(REPO_FILE), ...readFile(OPERATOR_FILE)]) {
    if (!valid(f)) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    merged.push({
      id: String(f.id),
      series: String(f.series || 'Feature'),
      title: String(f.title),
      episode: f.episode || null,
      synopsis: String(f.synopsis || ''),
      provider: String(f.provider || 'youtube'),
      ref: String(f.ref),
      url: f.url ? String(f.url) : null,
      art: f.art ? String(f.art) : null,
      duration: Number(f.duration) || 1500,
      published: f.published || null,
    });
  }
  cache = { at: now, list: merged };
  return merged;
}

function reload() {
  cache = { at: 0, list: [] };
  return list();
}

module.exports = { list, reload, REPO_FILE, OPERATOR_FILE };
