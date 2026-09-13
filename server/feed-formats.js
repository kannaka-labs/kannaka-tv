'use strict';
// Reading feeds that were not written for us.
//
// ADR-0001 decision 3 says there are exactly two kinds of programming a third party may file, and
// this does not add a third. An RSS or Atom feed is still *a feed* — data we fetch and render with
// our own renderers. All this file does is translate a wire format the world already speaks into
// the shapes carriage-core already validates. No new renderer, no markup from outside.
//
// PURE. No I/O. Deliberately no XML dependency: the repo has one dependency and this does not need
// a parser that can do entities, namespaces and DTDs — it needs to pull a title, a link and a date
// out of at most twenty entries and refuse anything surprising.

const MAX_ITEMS = 10;
const MAX_SCAN = 512 * 1024; // never walk more than this much markup, whatever the server sent

class FeedFormatError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Minimal, bounded XML text extraction
// ---------------------------------------------------------------------------

/** Decode only the five predefined entities plus numeric ones. No DTD, no external entities. */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&'); // last, so &amp;lt; does not become <
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0x20 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Strip CDATA and tags, decode entities, then STRIP TAGS AGAIN.
 *
 * The second pass is the point. Stripping before decoding leaves `&lt;script&gt;` untouched — it
 * is not a tag yet — and the decode then turns it into a literal `<script>` in the output. The
 * client renders with textContent so that is inert today, but it is one innerHTML away from not
 * being, and a broadcast title should never contain a tag either way. A lone `<` with no closing
 * bracket (`5 < 6`) is left alone, because it is text.
 */
const TAG = /<[^<>]*>/g;
// The second pass is narrower ON PURPOSE: it must begin with a letter or a slash-then-letter, so
// it matches `<script>` and `</b>` but not prose like "5 < 6 and 7 > 2". A blanket `<[^<>]*>`
// here turned that sentence into "5 2".
const TAG_AFTER_DECODE = /<\/?[a-zA-Z][^<>]*>/g;

function textOf(xml) {
  if (typeof xml !== 'string') return '';
  const once = decodeEntities(
    xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(TAG, ' ')
  );
  return once.replace(TAG_AFTER_DECODE, ' ').replace(/\s+/g, ' ').trim();
}

function firstTag(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
    if (m) return m[1];
  }
  return '';
}

/** Atom links live in an attribute, RSS links in the element body. Handle both. */
function linkOf(block) {
  const rss = firstTag(block, ['link']);
  const asText = textOf(rss);
  if (/^https?:\/\//i.test(asText)) return asText;
  const atom = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (atom && /^https?:\/\//i.test(atom[1])) return decodeEntities(atom[1]);
  return '';
}

function dateOf(block) {
  const raw = textOf(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']));
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an RSS 2.0 or Atom document into `{ title, items: [{title, link, summary, at}] }`.
 * Throws FeedFormatError; never returns a partial object that looks whole.
 */
function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new FeedFormatError('feed_empty', 'the feed returned nothing');
  }
  const doc = xml.length > MAX_SCAN ? xml.slice(0, MAX_SCAN) : xml;
  if (!/<(rss|feed|rdf:RDF)\b/i.test(doc)) {
    throw new FeedFormatError('not_a_feed', 'not an RSS or Atom document');
  }

  // The channel/feed title is the first <title> that is NOT inside an item/entry.
  const firstItemAt = doc.search(/<(item|entry)\b/i);
  const head = firstItemAt > 0 ? doc.slice(0, firstItemAt) : doc;
  const feedTitle = textOf(firstTag(head, ['title'])).slice(0, 120);

  const blocks = doc.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  const items = [];
  for (const b of blocks) {
    if (items.length >= MAX_ITEMS) break;
    const title = textOf(firstTag(b, ['title'])).slice(0, 180);
    if (!title) continue; // an entry with no title is not something we can put on screen
    items.push({
      title,
      link: linkOf(b).slice(0, 500),
      summary: textOf(firstTag(b, ['description', 'summary', 'content'])).slice(0, 300),
      at: dateOf(b),
    });
  }

  if (!items.length) throw new FeedFormatError('feed_no_items', 'the feed has no usable entries');
  return { title: feedTitle, items };
}

/**
 * Turn a parsed feed into the payload one of our existing renderers already accepts.
 * `list` is the honest default: a feed IS a list of things.
 */
function toPayload(parsed, template, label) {
  const headline = parsed.title || label || 'Feed';
  if (template === 'card') {
    return {
      template: 'card',
      headline,
      lines: parsed.items.slice(0, 6).map((i) => i.title),
      footer: parsed.items.length > 6 ? `${parsed.items.length} items in the feed` : undefined,
      updatedAt: Date.now(),
    };
  }
  // `list` (and anything else) renders as rows: the headline, and what is in it.
  return {
    template: 'list',
    headline,
    rows: parsed.items.slice(0, 10).map((i) => ({
      label: i.title,
      value: i.at ? relative(i.at) : '',
      note: i.summary ? i.summary.slice(0, 120) : '',
    })),
    updatedAt: Date.now(),
  };
}

function relative(at) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 0) return 'soon';
  if (mins < 60) return mins + 'm';
  const h = Math.round(mins / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

module.exports = { parseFeed, toPayload, textOf, decodeEntities, linkOf, FeedFormatError, MAX_ITEMS };
