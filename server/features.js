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
const MUSIC_REPO_FILE = path.join(__dirname, '..', 'data', 'music.json');
const MUSIC_OPERATOR_FILE = path.join(config.dataDir, 'music.json');
const COMMERCIALS_REPO_FILE = path.join(__dirname, '..', 'data', 'commercials.json');
const COMMERCIALS_OPERATOR_FILE = path.join(config.dataDir, 'commercials.json');

let cache = { at: 0, list: [] };
let musicCache = { at: 0, list: [] };
let commercialsCache = { at: 0, list: [] };
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

/** The music-video slate: short-form, carried by reference, same rules as the long-form one. */
function music() {
  const now = Date.now();
  if (now - musicCache.at < TTL_MS) return musicCache.list;
  const merged = [];
  const seen = new Set();
  for (const m of [...readFile(MUSIC_REPO_FILE), ...readFile(MUSIC_OPERATOR_FILE)]) {
    if (!m || typeof m !== 'object' || !m.ref || !m.track) continue;
    if (String(m.provider || 'youtube') === 'youtube' && !YT.test(String(m.ref))) continue;
    if (seen.has(m.ref)) continue;
    seen.add(m.ref);
    merged.push({
      id: String(m.id || m.ref),
      artist: String(m.artist || 'Kannaka'),
      track: String(m.track),
      album: m.album ? String(m.album) : null,
      provider: String(m.provider || 'youtube'),
      ref: String(m.ref),
      url: m.url ? String(m.url) : null,
      duration: Number(m.duration) || 240,
      published: m.published || null,
    });
  }
  musicCache = { at: now, list: merged };
  return merged;
}

/** The commercial slate: house spots, 10-90 s, carried by reference (ADR-0001 decision 3a). */
function commercials() {
  const now = Date.now();
  if (now - commercialsCache.at < TTL_MS) return commercialsCache.list;
  const merged = [];
  const seen = new Set();
  for (const s of [...readFile(COMMERCIALS_REPO_FILE), ...readFile(COMMERCIALS_OPERATOR_FILE)]) {
    if (!s || typeof s !== 'object' || !s.ref || !s.title) continue;
    if (String(s.provider || 'youtube') === 'youtube' && !YT.test(String(s.ref))) continue;
    if (seen.has(s.ref)) continue;
    // A spot outside 10-90 s is not a spot. Demand an actual number: `Number(null)` is 0 and
    // `Number(x) || default` would wave a missing duration through as a thirty-second default.
    const d = typeof s.duration === 'number' ? s.duration : Number(s.duration);
    if (!Number.isFinite(d) || d < 10 || d > 90) continue;
    seen.add(s.ref);
    merged.push({
      id: String(s.id || s.ref),
      title: String(s.title),
      sponsor: s.sponsor ? String(s.sponsor) : null,
      provider: String(s.provider || 'youtube'),
      ref: String(s.ref),
      url: s.url ? String(s.url) : null,
      duration: Math.round(d),
      published: s.published || null,
    });
  }
  commercialsCache = { at: now, list: merged };
  return merged;
}

function reload() {
  cache = { at: 0, list: [] };
  musicCache = { at: 0, list: [] };
  commercialsCache = { at: 0, list: [] };
  return { features: list().length, music: music().length, commercials: commercials().length };
}

module.exports = { list, music, commercials, reload, REPO_FILE, OPERATOR_FILE, MUSIC_REPO_FILE, MUSIC_OPERATOR_FILE, COMMERCIALS_REPO_FILE, COMMERCIALS_OPERATOR_FILE };
