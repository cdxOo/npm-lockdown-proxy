#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UPSTREAM = 'https://registry.npmjs.org';
const PORT = process.env.PORT || 4873;
const WHITELIST_FILE = path.resolve(process.env.WHITELIST || 'whitelist.json');

function parseMinAge(str) {
  const m = /^min-age\s+(\d+)/.exec(str);
  return m ? parseInt(m[1], 10) : null;
}

function loadWhitelist() {
  let raw;
  try {
    if (WHITELIST_FILE.endsWith('.js')) {
      delete require.cache[require.resolve(WHITELIST_FILE)];
      raw = require(WHITELIST_FILE);
    } else {
      raw = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    }
  } catch {
    console.warn(`WARNING: could not load whitelist from '${WHITELIST_FILE}' - all packages will be blocked`);
    console.warn(`         Set the WHITELIST env var or create a whitelist.json in the working directory.`);
    return new Map();
  }
  // Normalise each entry to '*' (any version) or { exact: Set<string>, minAgeDays: number|null }.
  const wl = new Map();
  for (const [pkg, value] of Object.entries(raw)) {
    if (value === '*') {
      wl.set(pkg, '*');
    } else {
      const values = Array.isArray(value) ? value : [value];
      const exact = new Set();
      let minAgeDays = null;
      for (const v of values) {
        const age = parseMinAge(v);
        if (age !== null) {
          minAgeDays = age;
        } else {
          exact.add(v);
        }
      }
      wl.set(pkg, { exact, minAgeDays });
    }
  }
  return wl;
}

let whitelist = loadWhitelist();

process.on('SIGHUP', () => {
  whitelist = loadWhitelist();
  console.log('whitelist reloaded');
});

// Parse the request pathname into { pkg, version, isTarball, isMetadata }.
// pkg        - package name (scoped or plain), null for npm-internal paths
// version    - string if this is a tarball request with a parseable version, otherwise null
// isTarball  - true if the path looks like a tarball request
// isMetadata - true if this is a bare package metadata request
function parseRequest(pathname) {
  pathname = decodeURIComponent(pathname);
  if (pathname.startsWith('/-/')) return { pkg: null, version: null, isTarball: false, isMetadata: false };

  const parts = pathname.slice(1).split('/'); // drop leading /
  let pkg, rest;

  if (parts[0].startsWith('@')) {
    if (parts.length < 2) return { pkg: null, version: null, isTarball: false, isMetadata: false };
    pkg = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    pkg = parts[0] || null;
    rest = parts.slice(1);
  }

  // Tarball path: /pkg/-/pkg-1.2.3.tgz  or  /@scope/pkg/-/pkg-1.2.3.tgz
  let version = null;
  let isTarball = false;
  if (rest[0] === '-' && rest[1]?.endsWith('.tgz')) {
    isTarball = true;
    const filename = rest[1];
    const basename = pkg.includes('/') ? pkg.split('/')[1] : pkg;
    const prefix = `${basename}-`;
    if (filename.startsWith(prefix)) {
      version = filename.slice(prefix.length, -4); // strip prefix and .tgz
    }
  }

  const isMetadata = !isTarball && rest.length === 0;

  return { pkg, version, isTarball, isMetadata };
}

function deny(res, msg) {
  const body = JSON.stringify({ error: msg });
  res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveWhitelist(res) {
  const out = {};
  for (const [pkg, entry] of [...whitelist.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (entry === '*') {
      out[pkg] = '*';
    } else {
      const parts = [...entry.exact];
      if (entry.minAgeDays !== null) parts.push(`min-age ${entry.minAgeDays} days`);
      out[pkg] = parts.length === 1 ? parts[0] : parts;
    }
  }
  const body = JSON.stringify(out, null, 2);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Fetch JSON from the upstream registry (used to check version publish times).
function fetchUpstreamJSON(pkgPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(pkgPath, UPSTREAM);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Filter a package manifest to only include whitelisted versions.
// Removes non-allowed entries from versions, time, and dist-tags.
function filterManifest(body, entry) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }

  if (entry !== '*') {
    const now = Date.now();
    for (const v of Object.keys(data.versions || {})) {
      let keep = entry.exact.has(v);
      if (!keep && entry.minAgeDays !== null) {
        const publishedAt = data.time?.[v];
        if (publishedAt) {
          keep = (now - new Date(publishedAt).getTime()) / 86400000 >= entry.minAgeDays;
        }
      }
      if (!keep) delete data.versions[v];
    }

    const remaining = new Set(Object.keys(data.versions || {}));

    for (const k of Object.keys(data.time || {})) {
      if (k !== 'created' && k !== 'modified' && !remaining.has(k)) {
        delete data.time[k];
      }
    }

    for (const [tag, v] of Object.entries(data['dist-tags'] || {})) {
      if (!remaining.has(v)) delete data['dist-tags'][tag];
    }

    // If latest was removed, point it at the highest remaining allowed version.
    if (data['dist-tags'] && !data['dist-tags'].latest) {
      const versions = Object.keys(data.versions || {});
      if (versions.length > 0) {
        data['dist-tags'].latest = versions[versions.length - 1];
      }
    }
  }

  return Buffer.from(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('unhandled error:', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

async function handleRequest(req, res) {
  if (req.method === 'GET' && req.url.split('?')[0] === '/_proxy/whitelist') {
    console.log(`ALLOW    GET /_proxy/whitelist`);
    return serveWhitelist(res);
  }

  const { pkg, version, isTarball, isMetadata } = parseRequest(req.url.split('?')[0]);

  const entry = pkg !== null ? (whitelist.get(pkg) ?? whitelist.get('*') ?? null) : null;

  if (pkg !== null) {
    if (!entry) {
      console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}' not whitelisted`);
      return deny(res, `Package '${pkg}' is not on the whitelist`);
    }

    if (isTarball && version === null) {
      console.log(`BLOCKED  ${req.method} ${req.url} - could not parse version from tarball filename`);
      return deny(res, `Could not parse version from tarball filename`);
    }

    if (version !== null && entry !== '*') {
      let allowed = entry.exact.has(version);

      if (!allowed && entry.minAgeDays !== null) {
        let publishedAt = null;
        try {
          const manifest = await fetchUpstreamJSON(`/${pkg}`);
          publishedAt = manifest.time?.[version] ?? null;
        } catch (err) {
          console.error(`failed to fetch metadata for ${pkg}: ${err.message}`);
          return deny(res, `Could not verify version age for '${pkg}'`);
        }
        if (publishedAt !== null) {
          const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
          allowed = ageDays >= entry.minAgeDays;
        }
      }

      if (!allowed) {
        console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}@${version}' not an allowed version`);
        const reason = entry.minAgeDays !== null
          ? `minimum age: ${entry.minAgeDays} days`
          : `allowed: ${[...entry.exact].join(', ')}`;
        return deny(res, `Version '${version}' of '${pkg}' is not on the whitelist (${reason})`);
      }
    }
  }

  console.log(`ALLOW    ${req.method} ${req.url}`);

  const url = new URL(req.url, UPSTREAM);

  const needsFilter = isMetadata && entry !== null && entry !== '*';
  const headers = { ...req.headers, host: url.hostname };
  if (needsFilter) {
    headers['accept-encoding'] = 'identity';
    headers['accept'] = 'application/json'; // force full manifest so time field is present for min-age checks
  }

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: req.method,
    headers,
  };

  const proxy = https.request(options, (upstream) => {
    if (!needsFilter) {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
      return;
    }

    const chunks = [];
    upstream.on('data', chunk => chunks.push(chunk));
    upstream.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        res.writeHead(upstream.statusCode, upstream.headers);
        res.end();
        return;
      }
      const filtered = filterManifest(raw, entry);
      const responseHeaders = { ...upstream.headers, 'content-length': filtered.length };
      delete responseHeaders['transfer-encoding'];
      res.writeHead(upstream.statusCode, responseHeaders);
      res.end(filtered);
    });
  });

  proxy.on('error', (err) => {
    console.error(err.message);
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxy);
}

server.listen(PORT, () => {
  console.log(`npm proxy -> ${UPSTREAM} on http://localhost:${PORT}`);
  console.log(`whitelist  ${WHITELIST_FILE} (${whitelist.size} packages)`);
});
