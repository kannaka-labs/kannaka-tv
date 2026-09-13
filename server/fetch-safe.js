'use strict';
// Fetching data we did not write, from hosts we do not control.
//
// This file is the accumulated scar tissue of Agent-Kax #447 (tower webhook SSRF + DNS rebinding)
// and kannaka-radio #259 (analytics uploads). ADR-0001 decision 5 says none of it is optional.
//
//   - https only, and `https.request` rather than `fetch` so redirects are simply not followed
//   - one DNS resolution used for BOTH the check and the connect, via a custom `lookup`, so there
//     is no window in which the name can be rebound to a private address between the two
//   - IPv4-mapped IPv6 parsed in hex form as well as dotted form (::ffff:808:808 is 8.8.8.8)
//   - Content-Length precheck AND a streamed cap, Content-Encoding refused

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { URL } = require('node:url');

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

function ipv4IsPublicUnicast(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0) return false; // this network
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments / 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

function ipv6IsPublicUnicast(ip) {
  const lower = String(ip).toLowerCase().split('%')[0];
  if (lower === '::' || lower === '::1') return false;

  // IPv4-mapped, dotted form: ::ffff:8.8.8.8
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return ipv4IsPublicUnicast(dotted[1]);

  // IPv4-mapped, HEX form: ::ffff:808:808 — the form that slipped through once already.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
    return ipv4IsPublicUnicast(v4);
  }

  if (lower.startsWith('fe80')) return false; // link-local
  if (/^f[cd]/.test(lower)) return false; // unique local
  if (lower.startsWith('ff')) return false; // multicast
  if (lower.startsWith('2001:db8')) return false; // documentation
  if (lower.startsWith('64:ff9b')) return false; // NAT64 — can translate to a private v4
  return true;
}

function ipIsPublicUnicast(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4IsPublicUnicast(ip);
  if (v === 6) return ipv6IsPublicUnicast(ip);
  return false;
}

class FeedError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Vet a hostname that is written as an IP literal.
 *
 * ⚠ This MUST be called before the request, not left to `lookup`: Node connects straight to an IP
 * literal and never calls the lookup hook at all, so a `lookup`-only defence is silently bypassed
 * by `https://169.254.169.254/`. Found by the test that asserted the refusal code rather than
 * merely asserting that the call failed — ECONNREFUSED looks like a refusal and is not one.
 */
function assertHostAllowed(hostname) {
  if (net.isIP(hostname) && !ipIsPublicUnicast(hostname)) {
    throw new FeedError('address_not_public', `refused address ${hostname}`);
  }
}

/**
 * A `lookup` that resolves once, vets every address it got, and hands the socket only vetted ones.
 * Because the connect uses the very addresses we checked, a rebind between check and connect is
 * not possible — there is no second resolution to poison.
 */
function vettingLookup(hostname, options, callback) {
  // Belt and braces: a literal should already have been stopped by assertHostAllowed.
  if (net.isIP(hostname)) {
    if (!ipIsPublicUnicast(hostname)) {
      return callback(new FeedError('address_not_public', `refused address ${hostname}`));
    }
    return callback(null, hostname, net.isIP(hostname));
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length) return callback(new FeedError('dns_empty', `no address for ${hostname}`));
    const bad = list.find((a) => !ipIsPublicUnicast(a.address));
    if (bad) {
      // If ANY resolved address is private we refuse the host outright rather than cherry-picking a
      // public one — a host that resolves to both is either misconfigured or attacking us.
      return callback(new FeedError('address_not_public', `${hostname} resolves to ${bad.address}`));
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * Fetch a third-party feed. Resolves to { status, headers, body, bytes }.
 * Rejects with a FeedError whose `.code` names the refusal, so the segment can say why it is dark.
 */
function fetchFeed(rawUrl, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return reject(new FeedError('bad_url', 'not a URL'));
    }
    if (u.protocol !== 'https:') return reject(new FeedError('https_required', 'https only'));
    if (u.username || u.password) return reject(new FeedError('credentials_in_url', 'no userinfo'));
    try {
      assertHostAllowed(u.hostname);
    } catch (e) {
      return reject(e);
    }

    const req = https.request(
      {
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        // https.request does not follow redirects. That is the point; do not "fix" it.
        lookup: vettingLookup,
        headers: {
          accept: 'application/json',
          'user-agent': 'KannakaTV/1.0 (+https://tv.ninja-portal.com)',
          'accept-encoding': 'identity',
          ...(opts.headers || {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const enc = res.headers['content-encoding'];
        if (enc && enc !== 'identity') {
          res.destroy();
          return reject(new FeedError('encoding_refused', `content-encoding ${enc}`));
        }
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy();
          return reject(new FeedError('redirect_refused', `status ${res.statusCode}`));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new FeedError('too_large', `declared ${declared} bytes`));
        }

        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > maxBytes) {
            res.destroy();
            return reject(new FeedError('too_large', `exceeded ${maxBytes} bytes`));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            bytes,
          });
        });
        res.on('error', (e) => reject(new FeedError('read_failed', e.message)));
      }
    );

    req.on('timeout', () => {
      req.destroy(new FeedError('timeout', `no response in ${timeoutMs}ms`));
    });
    req.on('error', (e) => reject(e instanceof FeedError ? e : new FeedError('request_failed', e.message)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Fetch and parse JSON. A feed that answers with something other than JSON is a dark feed. */
async function fetchJson(url, opts) {
  const res = await fetchFeed(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new FeedError('bad_status', `status ${res.status}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new FeedError('not_json', 'body did not parse as JSON');
  }
}

module.exports = {
  fetchFeed,
  fetchJson,
  FeedError,
  assertHostAllowed,
  ipIsPublicUnicast,
  ipv4IsPublicUnicast,
  ipv6IsPublicUnicast,
  vettingLookup,
  DEFAULT_MAX_BYTES,
};
