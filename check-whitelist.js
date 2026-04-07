#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');

const PROXY_URL = process.env.PROXY || 'http://localhost:4873';
const REGISTRY = 'https://registry.npmjs.org';

function usage() {
  console.error('usage: npm-lockdown-proxy-check <package[@version]>');
  console.error('env:   PROXY=http://localhost:4873  (default)');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) usage();

// Parse "name", "name@ver", "@scope/name", "@scope/name@ver"
function parseArg(s) {
  if (s.startsWith('@')) {
    const rest = s.slice(1);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) usage();
    const scope = rest.slice(0, slashIdx);
    const afterSlash = rest.slice(slashIdx + 1);
    const atIdx = afterSlash.lastIndexOf('@');
    if (atIdx === -1) return { name: `@${scope}/${afterSlash}`, range: 'latest' };
    return { name: `@${scope}/${afterSlash.slice(0, atIdx)}`, range: afterSlash.slice(atIdx + 1) };
  }
  const atIdx = s.lastIndexOf('@');
  if (atIdx <= 0) return { name: s, range: 'latest' };
  return { name: s.slice(0, atIdx), range: s.slice(atIdx + 1) };
}

const { name: rootName, range: rootRange } = parseArg(arg);

// --- HTTP ---

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// --- Semver ---

function parseSemver(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)([-+].*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function semverCmp(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) {
    const d = pa[k] - pb[k]; if (d) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

function satisfies(version, range) {
  if (!range || range === '*' || range === 'latest' || range === 'x') return true;
  const v = parseSemver(version);
  if (!v) return false;

  if (range.includes('||'))
    return range.split('||').some(r => satisfies(version, r.trim()));

  // compound: ">=1.0.0 <2.0.0"
  if (/\s/.test(range) && !range.startsWith('^') && !range.startsWith('~'))
    return range.split(/\s+/).every(r => satisfies(version, r));

  let m;

  m = range.match(/^\^(\d+)\.(\d+)\.(\d+)/);
  if (m) {
    const [maj, min, pat] = m.slice(1).map(Number);
    if (maj > 0) return v.major === maj && semverCmp(version, `${maj}.${min}.${pat}`) >= 0;
    if (min > 0) return v.major === 0 && v.minor === min && semverCmp(version, `0.${min}.${pat}`) >= 0;
    return v.major === 0 && v.minor === 0 && v.patch === pat;
  }

  m = range.match(/^~(\d+)\.(\d+)\.(\d+)/);
  if (m) {
    const [maj, min, pat] = m.slice(1).map(Number);
    return v.major === maj && v.minor === min && semverCmp(version, `${maj}.${min}.${pat}`) >= 0;
  }

  m = range.match(/^>=(.+)$/);  if (m) return semverCmp(version, m[1]) >= 0;
  m = range.match(/^>(.+)$/);   if (m) return semverCmp(version, m[1]) > 0;
  m = range.match(/^<=(.+)$/);  if (m) return semverCmp(version, m[1]) <= 0;
  m = range.match(/^<(.+)$/);   if (m) return semverCmp(version, m[1]) < 0;

  return version === range;
}

function maxSatisfying(versions, range) {
  return versions.filter(v => satisfies(v, range)).sort(semverCmp).pop() ?? null;
}

// --- Whitelist ---

function parseMinAge(str) {
  const m = /^min-age\s+(\d+)/.exec(str);
  return m ? parseInt(m[1], 10) : null;
}

function parseWhitelist(raw) {
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
        if (age !== null) minAgeDays = age;
        else exact.add(v);
      }
      wl.set(pkg, { exact, minAgeDays });
    }
  }
  return wl;
}

function getEntry(wl, name) {
  return wl.get(name) ?? wl.get('*') ?? null;
}

function isVersionAllowed(entry, version, publishedAt) {
  if (!entry) return false;
  if (entry === '*') return true;
  if (entry.exact.has(version)) return true;
  if (entry.minAgeDays !== null && publishedAt) {
    const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
    return ageDays >= entry.minAgeDays;
  }
  return false;
}

function findValidVersion(entry, meta) {
  if (!entry || entry === '*') return null;
  const timeMap = meta.time || {};
  const allVersions = Object.keys(meta.versions || {}).sort(semverCmp);

  // Prefer the highest whitelisted exact version that exists in the registry
  const exactCandidates = [...entry.exact].filter(v => meta.versions?.[v]).sort(semverCmp);
  if (exactCandidates.length > 0) {
    const v = exactCandidates[exactCandidates.length - 1];
    return { version: v, date: timeMap[v] ?? null };
  }

  // Newest version satisfying min-age
  if (entry.minAgeDays !== null) {
    const now = Date.now();
    const qualifying = allVersions.filter(v => {
      const pub = timeMap[v];
      return pub && (now - new Date(pub).getTime()) / 86400000 >= entry.minAgeDays;
    });
    if (qualifying.length > 0) {
      const v = qualifying[qualifying.length - 1];
      return { version: v, date: timeMap[v] ?? null };
    }
  }

  return null;
}

// --- Registry fetcher with promise cache ---

const metaCache = new Map();
let fetchCount = 0;

function fetchMeta(name) {
  if (!metaCache.has(name)) {
    fetchCount++;
    process.stderr.write(`  [${fetchCount}] fetching ${name}\n`);
    metaCache.set(name, getJSON(`${REGISTRY}/${name}`).catch(e => {
      throw new Error(`registry error for ${name}: ${e.message}`);
    }));
  }
  return metaCache.get(name);
}

// --- Dep walk ---

const visited = new Set();
const blocked = [];
let allowedCount = 0;
let whitelist;

async function walk(name, range) {
  let meta;
  try {
    meta = await fetchMeta(name);
  } catch (e) {
    process.stderr.write(`  warning: ${e.message}\n`);
    return;
  }

  const versions = Object.keys(meta.versions || {});
  const resolved = (!range || range === 'latest')
    ? meta['dist-tags']?.latest
    : (maxSatisfying(versions, range) ?? meta['dist-tags']?.latest);

  if (!resolved) {
    process.stderr.write(`  warning: could not resolve ${name}@${range}\n`);
    return;
  }

  const key = `${name}@${resolved}`;
  if (visited.has(key)) return;
  visited.add(key);

  const publishedAt = meta.time?.[resolved] ?? null;
  const entry = getEntry(whitelist, name);
  const allowed = isVersionAllowed(entry, resolved, publishedAt);

  if (allowed) {
    allowedCount++;
  } else {
    const valid = findValidVersion(entry, meta);
    blocked.push({
      name,
      version: resolved,
      publishedAt,
      validVersion: valid?.version ?? null,
      validDate: valid?.date ?? null,
    });
  }

  const deps = Object.entries(meta.versions?.[resolved]?.dependencies || {});
  await Promise.all(deps.map(([depName, depRange]) => walk(depName, depRange)));
}

// --- Output ---

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

function pad(s, n) { return String(s ?? '').padEnd(n); }

async function main() {
  let whitelistRaw;
  try {
    whitelistRaw = await getJSON(`${PROXY_URL}/_proxy/whitelist`);
  } catch (e) {
    console.error(`error: could not reach proxy at ${PROXY_URL}: ${e.message}`);
    console.error('       Is the proxy running? Set PROXY=http://host:port to override.');
    process.exit(1);
  }

  whitelist = parseWhitelist(whitelistRaw);

  process.stderr.write(`checking ${rootName}@${rootRange} via ${PROXY_URL}\n\n`);

  await walk(rootName, rootRange);

  process.stderr.write('\n');

  const total = blocked.length + allowedCount;

  if (blocked.length === 0) {
    console.log(`All ${total} package(s) are whitelisted.`);
    return;
  }

  blocked.sort((a, b) => a.name.localeCompare(b.name));

  const W = {
    name: Math.max(10, ...blocked.map(r => r.name.length)) + 2,
    ver:  Math.max(9,  ...blocked.map(r => r.version.length)) + 2,
    date: 12,
    valid: Math.max(13, ...blocked.map(r => (r.validVersion ?? 'none').length)) + 2,
  };

  const header =
    pad('Package',       W.name) +
    pad('Version',       W.ver)  +
    pad('Published',     W.date) +
    pad('Valid Version', W.valid) +
    'Valid Published';

  console.log(`${blocked.length} blocked / ${total} total packages:\n`);
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of blocked) {
    console.log(
      pad(r.name,                    W.name) +
      pad(r.version,                 W.ver)  +
      pad(fmtDate(r.publishedAt),    W.date) +
      pad(r.validVersion ?? 'none',  W.valid) +
      (r.validVersion ? fmtDate(r.validDate) : '—')
    );
  }
}

main().catch(e => {
  console.error('fatal:', e.message);
  process.exit(1);
});
