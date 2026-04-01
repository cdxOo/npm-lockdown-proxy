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
    console.warn(`WARNING: could not load whitelist from '${WHITELIST_FILE}' — all packages will be blocked`);
    console.warn(`         Set the WHITELIST env var or create a whitelist.json in the working directory.`);
    return {};
  }
  // Normalise each entry to an array of allowed versions, or '*' for any.
  const wl = {};
  for (const [pkg, versions] of Object.entries(raw)) {
    if (versions === '*') {
      wl[pkg] = '*';
    } else if (Array.isArray(versions)) {
      wl[pkg] = versions;
    } else {
      wl[pkg] = [versions];
    }
  }
  return wl;
}

let whitelist = loadWhitelist();

process.on('SIGHUP', () => {
  whitelist = loadWhitelist();
  console.log('whitelist reloaded');
});

// Parse the request pathname into { pkg, version }.
// pkg     - package name (scoped or plain), null for npm-internal paths
// version - string if this is a tarball request, otherwise null
function parseRequest(pathname) {
  if (pathname.startsWith('/-/')) return { pkg: null, version: null };

  const parts = pathname.slice(1).split('/'); // drop leading /
  let pkg, rest;

  if (parts[0].startsWith('@')) {
    if (parts.length < 2) return { pkg: null, version: null };
    pkg = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    pkg = parts[0] || null;
    rest = parts.slice(1);
  }

  // Tarball path: /pkg/-/pkg-1.2.3.tgz  or  /@scope/pkg/-/pkg-1.2.3.tgz
  // rest would be ['-', 'pkg-1.2.3.tgz'] at this point
  let version = null;
  if (rest[0] === '-' && rest[1]?.endsWith('.tgz')) {
    const filename = rest[1];
    const basename = pkg.includes('/') ? pkg.split('/')[1] : pkg;
    const prefix = `${basename}-`;
    if (filename.startsWith(prefix)) {
      version = filename.slice(prefix.length, -4); // strip prefix and .tgz
    }
  }

  return { pkg, version };
}

function deny(res, msg) {
  const body = JSON.stringify({ error: msg });
  res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const { pkg, version } = parseRequest(req.url.split('?')[0]);

  if (pkg !== null) {
    if (!Object.keys(whitelist).includes(pkg)) {
      console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}' not whitelisted`);
      return deny(res, `Package '${pkg}' is not on the whitelist`);
    }

    const allowed = whitelist[pkg];
    if (version !== null && allowed !== '*' && !allowed.includes(version)) {
      console.log(`BLOCKED  ${req.method} ${req.url} - '${pkg}@${version}' not an allowed version`);
      return deny(res, `Version '${version}' of '${pkg}' is not on the whitelist (allowed: ${allowed.join(', ')})`);
    }
  }

  console.log(`ALLOW    ${req.method} ${req.url}`);

  const url = new URL(req.url, UPSTREAM);
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.hostname },
  };

  const proxy = https.request(options, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
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
  console.log(`whitelist  ${WHITELIST_FILE} (${Object.keys(whitelist).length} packages)`);
});
