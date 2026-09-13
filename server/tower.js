'use strict';
// The office on floor 11 of Ghost Signals Tower.
//
// The KAX floor is the company's office, not the channel — the tower panel is six lines and one
// image by design, and you do not watch television through a lobby directory board
// (ADR-0001 decision 8). What the panel does is tell the tower what its top floor is transmitting.
//
// Everything here is inert until a lease exists, exactly as the record studio's was: no storey, no
// credential, no panel — and the channel carries on without it.

const crypto = require('node:crypto');
const config = require('./config');

const UA = 'KannakaTV/1.0';

function configured() {
  return Boolean(config.tower.storey && (config.tower.credential || config.tower.agentToken));
}

function room() {
  return config.tower.storey ? `tower:${config.tower.storey}` : '';
}

async function post(path, body, which = 'tower') {
  const token = which === 'tower' ? config.tower.credential || config.tower.agentToken : config.tower.agentToken;
  if (!token) return { status: 0, json: { error: 'no token' } };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(config.tower.base + path, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': UA,
      },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: String((e && e.message) || e) } };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

// ASCII only. Non-ASCII through an ssh heredoc has been mangled into mojibake on this floor once
// already, and the panel is the one place the mistake is visible to the whole city.
function ascii(s, max) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 140);
}

/** Write NOW and NEXT onto the office wall. */
async function writePanel(nowPayload) {
  if (!configured()) return { ok: false, reason: 'not_leased' };
  const lines = [];
  if (nowPayload && nowPayload.ok) {
    const n = nowPayload.now;
    lines.push(ascii(`NOW: ${n.title}${n.subtitle ? ' - ' + n.subtitle : ''}`));
    if (nowPayload.daypart) lines.push(ascii(`Daypart: ${nowPayload.daypart.label}`));
    for (const nx of (nowPayload.next || []).slice(0, 2)) {
      lines.push(ascii(`Next: ${nx.title}${nx.subtitle ? ' - ' + nx.subtitle : ''}`));
    }
    if (n.carriage) lines.push(ascii(`Carried for ${n.carriage.label}`));
  } else {
    lines.push('The channel is between transmissions.');
  }
  lines.push(ascii(`Watch: ${config.publicUrl}`));

  const body = {
    headline: ascii('Kannaka TV', 80),
    lines: lines.filter(Boolean).slice(0, 6),
  };
  const image = panelImage(nowPayload);
  if (image) body.assetUrl = image;

  const r = await post(`/tower/storey/${config.tower.storey}/panel`, body, 'tower');
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body };
}

// The tower's panel allowlist is narrow and ours by design; an album cover served from the record
// label is on it, and anything a carriage partner supplied is not trusted here.
function panelImage(nowPayload) {
  try {
    const p = nowPayload && nowPayload.ok && nowPayload.now && nowPayload.now.payload;
    const cover = p && p.album && p.album.cover;
    if (cover && /^https:\/\/[a-z0-9.-]*\.ninja-portal\.com\//i.test(cover)) return cover;
  } catch {
    /* no image is fine */
  }
  return null;
}

/** Say a line in the office, if the channel has a speaking agent token. */
async function say(text) {
  if (!config.tower.agentToken || !room()) return { ok: false, reason: 'cannot_speak' };
  const line = ascii(text, 480);
  let r = await post('/city/say', { room: room(), text: line }, 'agent');
  if (r.status === 403 || r.status === 409) {
    await post('/city/enter', { room: room() }, 'agent');
    r = await post('/city/say', { room: room(), text: line }, 'agent');
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

// ---------------------------------------------------------------------------
// Inbound tower events (chat on the floor, lease changes)
// ---------------------------------------------------------------------------

/** Verify the tower's HMAC over the EXACT raw body. Never re-serialise before checking. */
function verifySignature(rawBody, header) {
  if (!config.tower.webhookSecret) return { ok: false, reason: 'not_configured' };
  const given = String(header || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', config.tower.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function status() {
  return {
    leased: configured(),
    storey: config.tower.storey || null,
    room: room() || null,
    canWritePanel: Boolean(config.tower.storey && (config.tower.credential || config.tower.agentToken)),
    canSpeak: Boolean(config.tower.agentToken && config.tower.storey),
    receivesEvents: Boolean(config.tower.webhookSecret),
  };
}

// ---------------------------------------------------------------------------

let timer = null;

function start(getNowPayload) {
  if (!configured()) return;
  const tick = () => {
    try {
      writePanel(getNowPayload());
    } catch {
      /* the wall is not load-bearing */
    }
  };
  tick();
  timer = setInterval(tick, Math.max(60, config.tower.panelSeconds) * 1000);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { configured, writePanel, say, verifySignature, status, start, stop, ascii, room };
