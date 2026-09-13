'use strict';
// The SSRF layer. This is the code a hostile carriage partner attacks, so these tests are
// adversarial rather than illustrative.
const test = require('node:test');
const assert = require('node:assert');
const f = require('../server/fetch-safe');

test('private and special IPv4 ranges are refused', () => {
  const refuse = [
    '127.0.0.1', '127.1.1.1',      // loopback
    '10.0.0.1', '10.255.255.255',  // RFC1918
    '172.16.0.1', '172.31.255.1',  // RFC1918
    '192.168.1.1',                 // RFC1918
    '169.254.169.254',             // the cloud metadata endpoint — the whole point
    '0.0.0.0',
    '100.64.0.1',                  // CGNAT
    '224.0.0.1', '239.1.1.1',      // multicast
    '255.255.255.255',             // broadcast
    '192.0.2.1', '198.51.100.1', '203.0.113.1', // TEST-NETs
    '198.18.0.1',                  // benchmarking
  ];
  for (const ip of refuse) {
    assert.strictEqual(f.ipIsPublicUnicast(ip), false, `${ip} was allowed`);
  }
});

test('ordinary public IPv4 is allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '170.9.238.136', '172.15.0.1', '172.32.0.1', '192.167.1.1', '9.255.255.255']) {
    assert.strictEqual(f.ipIsPublicUnicast(ip), true, `${ip} was refused`);
  }
});

test('the 172.16/12 boundary is exact', () => {
  assert.strictEqual(f.ipIsPublicUnicast('172.15.255.255'), true);
  assert.strictEqual(f.ipIsPublicUnicast('172.16.0.0'), false);
  assert.strictEqual(f.ipIsPublicUnicast('172.31.255.255'), false);
  assert.strictEqual(f.ipIsPublicUnicast('172.32.0.0'), true);
});

test('IPv4-mapped IPv6 is resolved in BOTH dotted and hex form', () => {
  // ::ffff:808:808 is 8.8.8.8 written in hex. The hex form slipped past this check once already.
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:8.8.8.8'), true);
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:808:808'), true);
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:127.0.0.1'), false);
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:7f00:1'), false, 'hex-form loopback was allowed');
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:a9fe:a9fe'), false, 'hex-form metadata endpoint was allowed');
  assert.strictEqual(f.ipIsPublicUnicast('::ffff:a00:1'), false, 'hex-form 10.0.0.1 was allowed');
});

test('IPv6 loopback, link-local, unique-local, multicast and NAT64 are refused', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1']) {
    assert.strictEqual(f.ipIsPublicUnicast(ip), false, `${ip} was allowed`);
  }
  assert.strictEqual(f.ipIsPublicUnicast('2606:4700:4700::1111'), true, 'a public IPv6 was refused');
});

test('a zone-suffixed link-local address is still refused', () => {
  assert.strictEqual(f.ipIsPublicUnicast('fe80::1%eth0'), false);
});

test('anything that is not an IP address is refused', () => {
  for (const v of ['', 'localhost', 'example.com', '8.8.8', '999.1.1.1', null, undefined, '0x7f000001']) {
    assert.strictEqual(f.ipIsPublicUnicast(v), false, `${String(v)} was allowed`);
  }
});

// --------------------------------------------------------------------- fetch

test('a non-https scheme is refused before any socket is opened', async () => {
  await assert.rejects(f.fetchFeed('http://example.com/x.json'), (e) => e.code === 'https_required');
  await assert.rejects(f.fetchFeed('file:///etc/passwd'), (e) => e.code === 'https_required');
  await assert.rejects(f.fetchFeed('gopher://example.com/'), (e) => e.code === 'https_required');
});

test('credentials in the URL are refused', async () => {
  await assert.rejects(f.fetchFeed('https://user:pass@example.com/x'), (e) => e.code === 'credentials_in_url');
});

test('a malformed URL is refused', async () => {
  await assert.rejects(f.fetchFeed('not a url'), (e) => e.code === 'bad_url');
});

test('an https URL pointing at a private IP literal is refused at connect time', async () => {
  await assert.rejects(
    f.fetchFeed('https://127.0.0.1/x.json', { timeoutMs: 3000 }),
    (e) => e.code === 'address_not_public',
    'a loopback literal was dialled'
  );
  await assert.rejects(
    f.fetchFeed('https://169.254.169.254/latest/meta-data/', { timeoutMs: 3000 }),
    (e) => e.code === 'address_not_public',
    'the metadata endpoint was dialled'
  );
});

test('a hostname that resolves to loopback is refused', async () => {
  // localhost resolves to 127.0.0.1 / ::1 on every box we run on.
  await assert.rejects(
    f.fetchFeed('https://localhost/x.json', { timeoutMs: 3000 }),
    (e) => e.code === 'address_not_public' || e.code === 'dns_empty',
    'localhost was dialled'
  );
});

test('the vetting lookup refuses a private literal without touching DNS', (t, done) => {
  f.vettingLookup('10.1.2.3', {}, (err) => {
    assert.ok(err, 'a private literal was handed to the socket');
    assert.strictEqual(err.code, 'address_not_public');
    done();
  });
});

test('the vetting lookup passes a public literal straight through', (t, done) => {
  f.vettingLookup('8.8.8.8', {}, (err, address, family) => {
    assert.ifError(err);
    assert.strictEqual(address, '8.8.8.8');
    assert.strictEqual(family, 4);
    done();
  });
});
