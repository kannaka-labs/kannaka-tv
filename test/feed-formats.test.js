'use strict';
// Reading feeds nobody wrote for us. These are adversarial: an RSS feed is markup from a stranger,
// and the only reason it is safe to carry is that nothing survives this file except plain text
// that then goes through carriage-core's validation like any other feed.

const test = require('node:test');
const assert = require('node:assert');
const ff = require('../server/feed-formats');
const core = require('../server/carriage-core');

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Odin Station</title>
  <link>https://example.com</link>
  <item>
    <title>Band open to Europe</title>
    <link>https://example.com/1</link>
    <description>Twenty metres, three contacts.</description>
    <pubDate>Sat, 13 Sep 2026 17:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Rotator stuck at 210</title>
    <link>https://example.com/2</link>
    <description>Again.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Archivist</title>
  <entry>
    <title>The Open Frame</title>
    <link href="https://example.com/a"/>
    <summary>A figure in a picture that was never there before.</summary>
    <updated>2026-09-13T18:02:00Z</updated>
  </entry>
</feed>`;

test('an RSS 2.0 feed parses to title and items', () => {
  const p = ff.parseFeed(RSS);
  assert.strictEqual(p.title, 'Odin Station');
  assert.strictEqual(p.items.length, 2);
  assert.strictEqual(p.items[0].title, 'Band open to Europe');
  assert.strictEqual(p.items[0].link, 'https://example.com/1');
  assert.ok(p.items[0].at > 0, 'pubDate was not parsed');
  assert.strictEqual(p.items[1].at, null, 'a missing date must be null, not a guess');
});

test('an Atom feed parses, including the link in its href attribute', () => {
  const p = ff.parseFeed(ATOM);
  assert.strictEqual(p.title, 'The Archivist');
  assert.strictEqual(p.items[0].title, 'The Open Frame');
  assert.strictEqual(p.items[0].link, 'https://example.com/a', 'the Atom href form was missed');
});

test('the feed title is the channel title, never the first item title', () => {
  // The naive regex grabs the first <title> in the document, which in a headerless feed is an
  // item's. Getting this wrong labels every segment with its own first story.
  const p = ff.parseFeed(RSS);
  assert.notStrictEqual(p.title, 'Band open to Europe');
});

test('markup in a title never survives — tags are stripped, not escaped', () => {
  const nasty = RSS.replace(
    '<title>Band open to Europe</title>',
    '<title>Band &lt;script&gt;alert(1)&lt;/script&gt; open</title>'
  );
  const p = ff.parseFeed(nasty);
  assert.ok(!/<\/?[a-zA-Z][^<>]*>/.test(p.items[0].title), `a tag survived: ${p.items[0].title}`);
  assert.ok(!/script/i.test(p.items[0].title), `the script tag survived: ${p.items[0].title}`);
  assert.ok(p.items[0].title.includes('Band'), 'the real words were destroyed');
});

test('prose containing angle brackets is text, not markup, and survives', () => {
  // A narrower second strip than the first is required here: a blanket one turned this into "5 2".
  assert.strictEqual(ff.textOf('5 &lt; 6 and 7 &gt; 2'), '5 < 6 and 7 > 2');
  assert.strictEqual(ff.textOf('a &lt; b'), 'a < b');
  // ...while an entity-encoded tag is still removed.
  assert.strictEqual(ff.textOf('x &lt;i&gt;y&lt;/i&gt; z'), 'x y z');
});

test('CDATA is unwrapped and the markup inside it is still stripped', () => {
  const cdata = RSS.replace(
    '<title>Band open to Europe</title>',
    '<title><![CDATA[Band <b>open</b> to Europe]]></title>'
  );
  const p = ff.parseFeed(cdata);
  assert.strictEqual(p.items[0].title, 'Band open to Europe');
});

test('entities decode once, and &amp;lt; does not become a bracket', () => {
  assert.strictEqual(ff.decodeEntities('a &amp; b'), 'a & b');
  assert.strictEqual(ff.decodeEntities('&amp;lt;'), '&lt;', 'double-decoded into markup');
  assert.strictEqual(ff.decodeEntities('&#65;&#x42;'), 'AB');
  assert.strictEqual(ff.decodeEntities('&#0;'), '', 'a control character was decoded in');
});

test('a javascript: or data: link is not treated as a link', () => {
  const bad = RSS.replace('<link>https://example.com/1</link>', '<link>javascript:alert(1)</link>');
  const p = ff.parseFeed(bad);
  assert.strictEqual(p.items[0].link, '', 'a javascript: URL was carried as a link');
});

test('an entry with no title is dropped rather than rendered blank', () => {
  const p = ff.parseFeed(RSS.replace('<title>Rotator stuck at 210</title>', ''));
  assert.strictEqual(p.items.length, 1);
});

test('items are capped', () => {
  const many =
    '<rss><channel><title>t</title>' +
    Array.from({ length: 50 }, (_, i) => `<item><title>Item ${i}</title></item>`).join('') +
    '</channel></rss>';
  assert.strictEqual(ff.parseFeed(many).items.length, ff.MAX_ITEMS);
});

test('documents that are not feeds are refused', () => {
  for (const [doc, code] of [
    ['', 'feed_empty'],
    ['   ', 'feed_empty'],
    ['<html><body>not a feed</body></html>', 'not_a_feed'],
    ['{"json":true}', 'not_a_feed'],
    ['<rss><channel><title>t</title></channel></rss>', 'feed_no_items'],
  ]) {
    try {
      ff.parseFeed(doc);
      assert.fail(`expected ${code} for ${JSON.stringify(doc.slice(0, 24))}`);
    } catch (e) {
      assert.strictEqual(e.code, code);
    }
  }
});

test('an enormous document is scanned only up to the cap', () => {
  const huge = '<rss><channel><title>t</title><item><title>First</title></item>' + 'x'.repeat(2_000_000) + '</channel></rss>';
  const p = ff.parseFeed(huge);
  assert.strictEqual(p.items[0].title, 'First');
});

// ------------------------------------------------------- into our own shapes

test('a parsed feed becomes a list payload our renderer already accepts', () => {
  const payload = ff.toPayload(ff.parseFeed(RSS), 'list', 'Odin');
  // The real assertion: it must survive the SAME validation a JSON feed does. A hostile feed must
  // not reach the screen by arriving over a different wire.
  const shaped = core.shapeFeedPayload('list', payload);
  assert.strictEqual(shaped.template, 'list');
  assert.strictEqual(shaped.headline, 'Odin Station');
  assert.ok(shaped.rows.length >= 1);
  assert.strictEqual(shaped.rows[0].label, 'Band open to Europe');
});

test('a parsed feed becomes a card payload that also survives validation', () => {
  const payload = ff.toPayload(ff.parseFeed(RSS), 'card', 'Odin');
  const shaped = core.shapeFeedPayload('card', payload);
  assert.strictEqual(shaped.template, 'card');
  assert.ok(shaped.lines.length >= 1 && shaped.lines.length <= 6);
});

test('a feed carrying an image URL cannot smuggle one onto the screen', () => {
  // toPayload never emits an image field, so an <image> in the source cannot reach the renderer.
  const withImage = RSS.replace('<title>Odin Station</title>',
    '<title>Odin Station</title><image><url>https://evil.example.com/x.png</url></image>');
  const shaped = core.shapeFeedPayload('list', ff.toPayload(ff.parseFeed(withImage), 'list', 'Odin'));
  assert.strictEqual(shaped.image, undefined, 'an image from an RSS feed reached the payload');
});

test('the wire format is validated on application and defaults to json', () => {
  const P = 'kax:agent:abc';
  const base = { label: 'Odin', kind: 'feed', template: 'list', feedUrl: 'https://example.com/f', dayparts: ['prime'] };
  assert.strictEqual(core.validateApplication(base, P).feedFormat, 'json');
  assert.strictEqual(core.validateApplication({ ...base, feedFormat: 'rss' }, P).feedFormat, 'rss');
  try {
    core.validateApplication({ ...base, feedFormat: 'yaml' }, P);
    assert.fail('an unknown wire format was accepted');
  } catch (e) {
    assert.strictEqual(e.code, 'feed_format_invalid');
  }
});
