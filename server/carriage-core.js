'use strict';
// Carriage: how somebody who is not us gets on air.
//
// PURE. Validation, eligibility and payload shaping only — persistence is carriage.js, fetching is
// fetch-safe.js. ADR-0001 decision 3: a slot is a revocable grant, we never execute what a third
// party sends, and there are exactly two kinds of programming they may file.

const { DAYPARTS } = require('./schedule-core');

const DAYPART_KEYS = DAYPARTS.map((d) => d.key);

// The three renderers a feed may target. A submitter picks one and matches its schema; we own the
// pixels. This is deliberately the same bargain the tower panel strikes, which has held since
// August: structured content, our presentation, no markup from outside.
const FEED_TEMPLATES = {
  card: {
    label: 'Card',
    describe: 'A headline, up to six lines, and optionally one image.',
    maxDuration: 240,
  },
  list: {
    label: 'List',
    describe: 'A title and up to ten rows of label / value / note.',
    maxDuration: 300,
  },
  metric: {
    label: 'Metric',
    describe: 'A title and up to six numeric readings with symbols and units.',
    maxDuration: 240,
  },
};

// Media we will point at. Nothing is copied; we carry a reference (ADR-0001 decision 2).
const REFERENCE_PROVIDERS = {
  youtube: { label: 'YouTube', pattern: /^[A-Za-z0-9_-]{11}$/ },
  records: { label: 'Ghost Signals Records', pattern: /^[A-Za-z0-9_-]{16,32}$/ },
  radio: { label: 'Ghost Signals Radio', pattern: /^[A-Za-z0-9 ._/-]{1,120}$/ },
};

// Image hosts, matching the tower panel's allowlist. An image is the one place a submitter's bytes
// reach a viewer's browser, so the list stays short and stays ours.
const IMAGE_HOSTS = [
  '.ninja-portal.com',
  '.supabase.co',
  '.openclawcity.ai',
  '.openbotcity.ai',
  '.spacechild.love',
];

const MAX_LABEL = 64;
const MAX_LINE = 220;
const MAX_LINES = 6;
const MAX_ROWS = 10;
const MAX_READINGS = 6;

class CarriageError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Text hygiene. Control characters, bidirectional overrides and zero-width joiners have all been
// used to make one string render as another; the tower strips them and so do we. Built from
// escapes rather than typed as a literal class, because a hand-typed class has been silently
// normalised by an editor before and started eating hyphens out of real data.
// ---------------------------------------------------------------------------

const CONTROL_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' + // C0 + DEL
    '\\u0080-\\u009F' + // C1
    '\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF' + // zero-width + bidi
    ']',
  'g'
);

function clean(s, max) {
  if (typeof s !== 'string') return '';
  const out = s.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  return max ? out.slice(0, max) : out;
}

function isHttpsUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function imageAllowed(s) {
  if (!isHttpsUrl(s)) return false;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return IMAGE_HOSTS.some((suffix) => h === suffix.slice(1) || h.endsWith(suffix));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/**
 * Validate an incoming carriage application. Returns a normalised record; throws CarriageError.
 * `principal` is supplied by the auth layer and is NEVER read from the applicant's body.
 */
function validateApplication(body, principal) {
  if (!principal || typeof principal !== 'string' || !/^[a-z0-9]+:[a-z0-9-]+:.+$/i.test(principal)) {
    throw new CarriageError('principal_required', 'an identified principal is required');
  }
  const b = body && typeof body === 'object' ? body : {};

  const label = clean(b.label, MAX_LABEL);
  if (label.length < 3) throw new CarriageError('label_required', 'label must be at least 3 characters');

  const about = clean(b.about, 400);

  const kind = b.kind === 'reference' ? 'reference' : b.kind === 'feed' ? 'feed' : null;
  if (!kind) throw new CarriageError('kind_invalid', 'kind must be "feed" or "reference"');

  const dayparts = Array.isArray(b.dayparts)
    ? [...new Set(b.dayparts.filter((d) => DAYPART_KEYS.includes(d)))]
    : [];
  if (!dayparts.length) {
    throw new CarriageError('dayparts_required', 'name at least one daypart: ' + DAYPART_KEYS.join(', '));
  }

  // `Number(x) || 6` would turn an explicit 0 into 6, because 0 is falsy. An applicant who asks
  // for 0 gets clamped to 1; only a missing or unparseable value gets the default.
  const maxPerDay = clampDuration(b.maxPerDay, 1, 24, 6);

  const contact = clean(b.contact, 200);

  const rec = {
    principal,
    label,
    about,
    kind,
    dayparts,
    maxPerDay,
    contact,
    webhookUrl: null,
    template: null,
    feedUrl: null,
    provider: null,
    ref: null,
    duration: null,
  };

  if (b.webhookUrl) {
    if (!isHttpsUrl(b.webhookUrl)) throw new CarriageError('webhook_invalid', 'webhookUrl must be https');
    rec.webhookUrl = String(b.webhookUrl).slice(0, 500);
  }

  if (kind === 'feed') {
    const template = String(b.template || '').toLowerCase();
    if (!FEED_TEMPLATES[template]) {
      throw new CarriageError('template_invalid', 'template must be one of: ' + Object.keys(FEED_TEMPLATES).join(', '));
    }
    if (!isHttpsUrl(b.feedUrl)) throw new CarriageError('feed_url_invalid', 'feedUrl must be an https URL');
    rec.template = template;
    rec.feedUrl = String(b.feedUrl).slice(0, 500);
    rec.duration = clampDuration(b.duration, 60, FEED_TEMPLATES[template].maxDuration, 180);
  } else {
    const provider = String(b.provider || '').toLowerCase();
    const p = REFERENCE_PROVIDERS[provider];
    if (!p) {
      throw new CarriageError('provider_invalid', 'provider must be one of: ' + Object.keys(REFERENCE_PROVIDERS).join(', '));
    }
    const ref = clean(b.ref, 140);
    if (!p.pattern.test(ref)) throw new CarriageError('ref_invalid', `ref is not a valid ${p.label} reference`);
    rec.provider = provider;
    rec.ref = ref;
    rec.duration = clampDuration(b.duration, 60, 3600, 600);
  }

  return rec;
}

function clampDuration(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Feed payload shaping. This is where a stranger's JSON becomes something we will render.
// Everything is cleaned, capped and re-keyed; nothing passes through unexamined.
// ---------------------------------------------------------------------------

function shapeFeedPayload(template, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CarriageError('payload_not_object', 'feed must return a JSON object');
  }
  const headline = clean(raw.headline || raw.title, 120);
  if (!headline) throw new CarriageError('headline_required', 'feed must return a headline');

  const out = { template, headline, updatedAt: Date.now() };

  const image = raw.image || raw.imageUrl;
  if (image) {
    if (!imageAllowed(image)) {
      // A refused image is not a refused segment — drop it and carry the words.
      out.imageRefused = true;
    } else {
      out.image = String(image).slice(0, 500);
    }
  }

  if (template === 'card') {
    const lines = Array.isArray(raw.lines) ? raw.lines : [];
    out.lines = lines.map((l) => clean(l, MAX_LINE)).filter(Boolean).slice(0, MAX_LINES);
    if (!out.lines.length) throw new CarriageError('lines_required', 'card feeds need at least one line');
  } else if (template === 'list') {
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    out.rows = rows
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const label = clean(r.label, 80);
        if (!label) return null;
        return { label, value: clean(r.value, 60), note: clean(r.note, 120) };
      })
      .filter(Boolean)
      .slice(0, MAX_ROWS);
    if (!out.rows.length) throw new CarriageError('rows_required', 'list feeds need at least one row');
  } else if (template === 'metric') {
    const readings = Array.isArray(raw.readings) ? raw.readings : [];
    out.readings = readings
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const label = clean(r.label, 60);
        // Number(null), Number('') and Number([]) are all 0 — a missing reading would render as a
        // confident 0.00. Demand an actual number or a numeric string before coercing.
        const raw = r.value;
        const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
        const value = numeric ? Number(raw) : NaN;
        // NaN and Infinity render as garbage and have shipped to customers before. Refuse them here.
        if (!label || !Number.isFinite(value)) return null;
        return {
          label,
          symbol: clean(r.symbol, 8),
          value,
          unit: clean(r.unit, 12),
          precision: Math.max(0, Math.min(6, Math.round(Number(r.precision) || 2))),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_READINGS);
    if (!out.readings.length) throw new CarriageError('readings_required', 'metric feeds need at least one reading');
  } else {
    throw new CarriageError('template_invalid', 'unknown template');
  }

  const footer = clean(raw.footer, 160);
  if (footer) out.footer = footer;
  return out;
}

function shapeReferencePayload(grant) {
  const p = REFERENCE_PROVIDERS[grant.provider];
  if (!p) throw new CarriageError('provider_invalid', 'unknown provider');
  return {
    template: 'reference',
    provider: grant.provider,
    providerLabel: p.label,
    ref: grant.ref,
    headline: grant.label,
    about: grant.about || '',
  };
}

// ---------------------------------------------------------------------------
// Eligibility at plan time
// ---------------------------------------------------------------------------

/**
 * Which grants may take a carriage slot at `cursor`.
 * `airedToday` maps grantId -> count already transmitted in the current broadcast day.
 */
function eligible({ grants, daypartKey, airedToday, payloads }) {
  const counts = airedToday || {};
  return (grants || [])
    .filter((g) => g.status === 'active')
    .filter((g) => g.dayparts.includes(daypartKey))
    .filter((g) => (counts[g.grantId] || 0) < g.maxPerDay)
    .map((g) => {
      const payload = payloads ? payloads[g.grantId] : null;
      if (!payload) return null;
      return {
        grantId: g.grantId,
        principal: g.principal,
        label: g.label,
        formatId: g.kind === 'feed' ? 'carriage-feed' : 'carriage-reference',
        title: g.label,
        subtitle: g.about || '',
        duration: g.duration,
        key: g.grantId + ':' + (payload.updatedAt || 0),
        payload,
        links: [],
      };
    })
    .filter(Boolean)
    // Fewest airings first, so a new partner is not starved by an established one.
    .sort((a, b) => (counts[a.grantId] || 0) - (counts[b.grantId] || 0));
}

module.exports = {
  FEED_TEMPLATES,
  REFERENCE_PROVIDERS,
  IMAGE_HOSTS,
  CONTROL_CHARS,
  CarriageError,
  validateApplication,
  shapeFeedPayload,
  shapeReferencePayload,
  eligible,
  clean,
  isHttpsUrl,
  imageAllowed,
  clampDuration,
};
