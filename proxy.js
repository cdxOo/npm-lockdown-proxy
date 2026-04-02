#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UPSTREAM = 'https://registry.npmjs.org';
const PORT = process.env.PORT || 4873;
const WHITELIST_FILE = path.resolve(process.env.WHITELIST || 'whitelist.json');

function loadWhitelist() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
  } catch {
    console.warn(`WARNING: could not load whitelist from '${WHITELIST_FILE}' - all packages will be blocked`);
    console.warn(`         Set the WHITELIST env var or create a whitelist.json in the working directory.`);
    return new Map();
  }
  // Normalise each entry to a Set of allowed versions, or '*' for any.
  const wl = new Map();
  for (const [pkg, versions] of Object.entries(raw)) {
    if (versions === '*') {
      wl.set(pkg, '*');
    } else if (Array.isArray(versions)) {
      wl.set(pkg, new Set(versions));
    } else {
      wl.set(pkg, new Set([versions]));
    }
  }
  return wl;
}

let whitelist = loadWhitelist();

process.on('SIGHUP', () => {
  whitelist = loadWhitelist();
  console.log('whitelist reloaded');
});

// Parse the request pathname into { pkg, version, isMetadata }.
// pkg        - package name (scoped or plain), null for npm-internal paths
// version    - string if this is a tarball request, otherwise null
// isMetadata - true if this is a bare package metadata request
function parseRequest(pathname) {
  pathname = decodeURIComponent(pathname);
  if (pathname.startsWith('/-/')) return { pkg: null, version: null, isMetadata: false };

  const parts = pathname.slice(1).split('/'); // drop leading /
  let pkg, rest;

  if (parts[0].startsWith('@')) {
    if (parts.length < 2) return { pkg: null, version: null, isMetadata: false };
    pkg = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    pkg = parts[0] || null;
    rest = parts.slice(1);
  }

  // Tarball path: /pkg/-/pkg-1.2.3.tgz  or  /@scope/pkg/-/pkg-1.2.3.tgz
  let version = null;
  if (rest[0] === '-' && rest[1]?.endsWith('.tgz')) {
    const filename = rest[1];
    const basename = pkg.includes('/') ? pkg.split('/')[1] : pkg;
    const prefix = `${basename}-`;
    if (filename.startsWith(prefix)) {
      version = filename.slice(prefix.length, -4); // strip prefix and .tgz
    }
  }

  const isMetadata = version === null && rest.length === 0;

  return { pkg, version, isMetadata };
}

function deny(res, msg) {
  const body = JSON.stringify({ error: msg });
  res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Filter a package manifest to only include whitelisted versions.
// Removes non-allowed entries from versions, time, and dist-tags.
function filterManifest(body, allowed) {
  const data = JSON.parse(body);

  for (const v of Object.keys(data.versions || {})) {
    if (!allowed.has(v)) delete data.versions[v];
  }

  for (const k of Object.keys(data.time || {})) {
    if (k !== 'created' && k !== 'modified' && !allowed.has(k)) {
      delete data.time[k];
    }
  }

  for (const [tag, v] of Object.entries(data['dist-tags'] || {})) {
    if (!allowed.has(v)) delete data['dist-tags'][tag];
  }

  // If latest was removed, point it at the highest remaining allowed version.
  if (data['dist-tags'] && !data['dist-tags'].latest) {
    const remaining = Object.keys(data.versions);
    if (remaining.length > 0) {
      data['dist-tags'].latest = remaining[remaining.length - 1];
    }
  }

  return Buffer.from(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const { pkg, version, isMetadata } = parseRequest(req.url.split('?')[0]);

  if (pkg !== null) {
    if (!whitelist.has(pkg)) {
      console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}' not whitelisted`);
      return deny(res, `Package '${pkg}' is not on the whitelist`);
    }

    const allowed = whitelist.get(pkg);
    if (version !== null && allowed !== '*' && !allowed.has(version)) {
      console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}@${version}' not an allowed version`);
      return deny(res, `Version '${version}' of '${pkg}' is not on the whitelist (allowed: ${[...allowed].join(', ')})`);
    }
  }

  console.log(`ALLOW    ${req.method} ${req.url}`);

  const url = new URL(req.url, UPSTREAM);

  const needsFilter = isMetadata && pkg !== null && whitelist.get(pkg) !== '*';
  const headers = { ...req.headers, host: url.hostname };
  if (needsFilter) headers['accept-encoding'] = 'identity';

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
      const filtered = filterManifest(raw, whitelist.get(pkg));
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
});

server.listen(PORT, () => {
  console.log(`npm proxy -> ${UPSTREAM} on http://localhost:${PORT}`);
  console.log(`whitelist  ${WHITELIST_FILE} (${whitelist.size} packages)`);
});
