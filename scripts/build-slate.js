#!/usr/bin/env node
/**
 * Rebuild the channel's slates from the published YouTube catalogue.
 *
 *   node scripts/build-slate.js --from catalogue.json     # shape a catalogue you already have
 *   YOUTUBE_API_KEY=... node scripts/build-slate.js       # fetch the public playlists, then shape
 *
 * Writes data/features.json (long-form, Prime) and data/music.json (short-form, overnight).
 *
 * The fetching is the easy half. The rules below are the half that took a while and each one is
 * here because it was got wrong first:
 *
 *   PUBLIC ONLY.        The Kannaka Radio playlist holds private and unlisted items. Carrying one
 *                       puts a dead embed on air and the viewer cannot tell whose fault it is.
 *   PROGRAMME vs TRACK. A programme is carried whatever its length; a track is not. The first
 *                       version used a nine-minute floor and silently dropped eight early Ghost
 *                       Signals episodes for running five to eight minutes. Length was the wrong
 *                       test — being an episode is the right one — so the floor now applies only
 *                       to music.
 *   RETIRED STAYS OUT.  GSP-007 was permanently retired from the station. It is absent from the
 *                       playlist today; this keeps it out even if that changes.
 *   NO OVERLAP.         Nothing is carried as both a feature and a music video.
 *
 * The catalogue file is an array of { playlist, items: [{ id, title, description, published,
 * seconds, privacy }] } — the shape `--from` expects and the shape the fetcher produces.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const FEATURES_OUT = path.join(ROOT, 'data', 'features.json');
const MUSIC_OUT = path.join(ROOT, 'data', 'music.json');

const MUSIC_MAX_SECONDS = 9 * 60; // longer than this is a feature and is carried as one
const MUSIC_MIN_SECONDS = 60;     // a sting or a trailer is not a music video
const RETIRED = new Set(['GSP-007']);

// The channel's playlists. Public, so an API key is enough — no OAuth.
const PLAYLISTS = [
  'PLr8fsczlhL9I4C5f1_TVHzfKXFusfUC0A', // Ghost Signals with Kannaka
  'PLcDUrrJ7GnOE',                      // The Story of Flaukowski
  'PLr8fsczlhL9Jw_RdAMOmkdKVD9nnqPeCY', // Kannaka Radio
  'PLXqHankEVYEs',                      // WHAT PERSISTED
  'PLSoIrcJseqGQ',                      // WHAT I KEEP
  'PLbDwm_1UcfP8',                      // THE OTHER SIDE
  'PLIXbXiDbcVxI',                      // SEVEN PORTALS
];

// ---------------------------------------------------------------- fetching

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch { reject(new Error(b.slice(0, 200))); }
        });
      })
      .on('error', reject);
  });
}

async function fetchCatalogue(key) {
  const api = 'https://www.googleapis.com/youtube/v3';
  const out = [];
  for (const id of PLAYLISTS) {
    const items = [];
    let pageToken = '';
    let title = id;
    do {
      const j = await getJson(
        `${api}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${id}` +
          `${pageToken ? '&pageToken=' + pageToken : ''}&key=${key}`
      );
      if (j.error) throw new Error(`${id}: ${j.error.message}`);
      for (const it of j.items || []) {
        title = it.snippet?.channelTitle || title;
        items.push({
          id: it.contentDetails?.videoId,
          title: it.snippet?.title || '',
          description: (it.snippet?.description || '').split('\n')[0].slice(0, 300),
          published: (it.contentDetails?.videoPublishedAt || '').slice(0, 10),
        });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);

    const pl = await getJson(`${api}/playlists?part=snippet&id=${id}&key=${key}`);
    out.push({ playlist: pl.items?.[0]?.snippet?.title || title, playlistId: id, items });
  }

  // durations + privacy, in batches
  const all = out.flatMap((p) => p.items).filter((x) => x.id);
  for (let i = 0; i < all.length; i += 50) {
    const ids = all.slice(i, i + 50).map((x) => x.id).join(',');
    const j = await getJson(`${api}/videos?part=contentDetails,status&id=${ids}&key=${key}`);
    const by = {};
    for (const v of j.items || []) {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails?.duration || '');
      by[v.id] = {
        seconds: m ? +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0) : null,
        privacy: v.status?.privacyStatus,
      };
    }
    for (const p of out) for (const it of p.items) if (by[it.id]) Object.assign(it, by[it.id]);
  }
  return out;
}

// ---------------------------------------------------------------- shaping

/** "GSP-034 — The Shelf and the List | Ghost Signals with Kannaka" -> episode + clean title */
function parseProgramme(title) {
  const ep = title.match(/^((?:GSP|TSOF)[- ][A-Z0-9]+)/i);
  let clean = title.split('|')[0].trim();
  if (ep) clean = clean.replace(/^(?:GSP|TSOF)[- ][A-Z0-9]+\s*[—–-]\s*/i, '').trim();
  return { episode: ep ? ep[1].replace(' ', '-').toUpperCase() : null, title: clean || title };
}

function seriesOf(playlist, title) {
  if (/^GSP-\d+/.test(title)) return 'Ghost Signals';
  if (/^TSOF/.test(title)) return 'The Story of Flaukowski';
  if (/full album/i.test(playlist) || /full album/i.test(title)) return 'The Albums';
  return 'Kannaka Radio';
}

const ARTISTS = ['Kannaka', 'Kannaktopus', 'Flaukowski', 'Kannaka × Flaukowski'];

/**
 * "Kannaka — Small Rooms (WHAT PERSISTED)" -> artist, track, album.
 *
 * Two traps, both from real titles: a dash does not always separate artist from track
 * ("For the Mothers — Mother's Day 2026" is one title), and parentheses are usually a version
 * marker rather than an album ("Rosa Rediit (Pop Edit)" is not an album called Pop Edit).
 */
function parseTrack(title, playlist) {
  let t = title.split('|')[0].trim();
  let album = null;
  const fromPlaylist = playlist.match(/^(.+?)\s+[—–-]\s+.*full album/i);
  if (fromPlaylist) album = fromPlaylist[1].trim();

  let artist = null;
  const dash = t.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  if (dash && ARTISTS.some((a) => a.toLowerCase() === dash[1].trim().toLowerCase())) {
    artist = dash[1].trim();
    t = dash[2].trim();
  }

  const paren = t.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (paren) {
    const inner = paren[2].trim();
    const looksLikeAlbum = /^[A-Z0-9][A-Z0-9 '.’&-]+$/.test(inner) && inner.length > 2;
    if (looksLikeAlbum && !album) { album = inner; t = paren[1].trim(); }
    else if (looksLikeAlbum && album && inner.toLowerCase() === album.toLowerCase()) t = paren[1].trim();
  }
  return { artist: artist || 'Kannaka', track: t || title, album };
}

function shape(cat) {
  const features = [];
  const music = [];
  const seen = new Set();

  for (const p of cat) {
    for (const it of p.items || []) {
      if (!it.id || seen.has(it.id)) continue;
      if (it.privacy !== 'public') continue;
      if (!it.seconds) continue;

      const { episode, title } = parseProgramme(it.title);
      if (episode && RETIRED.has(episode)) continue;

      if (episode) {
        // a programme, whatever its length
        seen.add(it.id);
        features.push({
          id: episode.toLowerCase(),
          series: seriesOf(p.playlist, it.title),
          title,
          episode,
          synopsis: (it.description || '').replace(/\s+/g, ' ').slice(0, 240),
          provider: 'youtube',
          ref: it.id,
          url: `https://www.youtube.com/watch?v=${it.id}`,
          duration: it.seconds,
          published: it.published || null,
        });
      } else if (it.seconds > MUSIC_MAX_SECONDS) {
        // long-form music: a full-album video is a feature
        seen.add(it.id);
        features.push({
          id: it.id.toLowerCase(),
          series: seriesOf(p.playlist, it.title),
          title,
          episode: null,
          synopsis: (it.description || '').replace(/\s+/g, ' ').slice(0, 240),
          provider: 'youtube',
          ref: it.id,
          url: `https://www.youtube.com/watch?v=${it.id}`,
          duration: it.seconds,
          published: it.published || null,
        });
      } else if (it.seconds >= MUSIC_MIN_SECONDS) {
        seen.add(it.id);
        const { artist, track, album } = parseTrack(it.title, p.playlist);
        music.push({
          id: it.id,
          artist,
          track,
          album,
          provider: 'youtube',
          ref: it.id,
          url: `https://www.youtube.com/watch?v=${it.id}`,
          duration: it.seconds,
          published: it.published || null,
        });
      }
    }
  }

  const ORDER = ['Ghost Signals', 'The Story of Flaukowski', 'The Albums', 'Kannaka Radio'];
  features.sort(
    (a, b) => ORDER.indexOf(a.series) - ORDER.indexOf(b.series) || String(b.published).localeCompare(String(a.published))
  );
  music.sort(
    (a, b) => String(a.album || 'zzz').localeCompare(String(b.album || 'zzz')) || String(a.track).localeCompare(String(b.track))
  );
  return { features, music };
}

// ---------------------------------------------------------------- checks

function check(features, music) {
  const problems = [];
  const fRefs = new Set(features.map((f) => f.ref));
  for (const m of music) if (fRefs.has(m.ref)) problems.push(`${m.ref} is carried as BOTH a feature and a music video`);
  if (features.some((f) => f.episode && RETIRED.has(f.episode))) problems.push('a retired episode is being carried');
  for (const x of [...features, ...music]) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(x.ref)) problems.push(`${x.id} has a malformed YouTube ref: ${x.ref}`);
    if (!x.duration || x.duration <= 0) problems.push(`${x.id} has no duration`);
  }
  const all = [...features, ...music].map((x) => x.ref);
  if (new Set(all).size !== all.length) problems.push('a video is carried twice');
  return problems;
}

// ---------------------------------------------------------------- main

(async () => {
  const argFrom = process.argv.indexOf('--from');
  let cat;
  if (argFrom > -1 && process.argv[argFrom + 1]) {
    cat = JSON.parse(fs.readFileSync(process.argv[argFrom + 1], 'utf8'));
  } else if (process.env.YOUTUBE_API_KEY) {
    cat = await fetchCatalogue(process.env.YOUTUBE_API_KEY);
  } else {
    console.error('Need either --from <catalogue.json> or YOUTUBE_API_KEY in the environment.');
    console.error('The playlists are public, so a plain Data API key is enough — no OAuth.');
    process.exit(2);
  }

  const { features, music } = shape(cat);
  const problems = check(features, music);
  if (problems.length) {
    console.error('REFUSING TO WRITE:');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }

  const dry = process.argv.includes('--dry-run');
  if (!dry) {
    fs.writeFileSync(FEATURES_OUT, JSON.stringify(features, null, 2) + '\n');
    fs.writeFileSync(MUSIC_OUT, JSON.stringify(music, null, 2) + '\n');
  }

  const by = {};
  for (const f of features) by[f.series] = (by[f.series] || 0) + 1;
  const hrs = (n) => (n / 3600).toFixed(1);
  console.log(`${dry ? '[dry run] ' : ''}features: ${features.length} (${hrs(features.reduce((n, f) => n + f.duration, 0))}h)`);
  for (const [s, n] of Object.entries(by)) console.log(`    ${String(n).padStart(3)}  ${s}`);
  console.log(`${dry ? '[dry run] ' : ''}music:    ${music.length} (${hrs(music.reduce((n, m) => n + m.duration, 0))}h)`);
  const skipped = cat.flatMap((p) => p.items || []).filter((x) => x.privacy && x.privacy !== 'public').length;
  console.log(`\nleft out: ${skipped} not public`);
})();
