#!/usr/bin/env node
// Step 1 of the loop: FIND. Plain HTTP checks, no paid API, $0 per run.
//
//   node scan/health-check.mjs                 # scan all properties, write scan/out/health-<date>.json
//   node scan/health-check.mjs --sample 50     # status-check 50 sitemap URLs per property (default 30)
//   node scan/health-check.mjs --diff a.json b.json   # step 3: what moved between two runs
//
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const PROPERTIES = [
  { id: 'musashi',        url: 'https://musashi.com/',          platform: 'Shopify' },
  { id: 'nutralife-au',   url: 'https://nutralife.com.au/',     platform: 'Shopify' },
  { id: 'nutralife-nz',   url: 'https://www.nutralife.co.nz/',  platform: 'WordPress / WooCommerce' },
  { id: 'healtheries-au', url: 'https://healtheries.com.au/',   platform: 'Next.js (agency)' },
  { id: 'healtheries-nz', url: 'https://healtheries.co.nz/',    platform: 'Next.js (agency)' },
  { id: 'aussiebodies',   url: 'https://aussiebodies.com/',     platform: 'WordPress / WooCommerce' },
];
// Same brand, two countries: each side should name the other in hreflang.
const PAIRS = [['nutralife-au', 'nutralife-nz'], ['healtheries-au', 'healtheries-nz']];

// Shopify edge returns 503 to bare bot UAs, so present as a browser but stay identifiable.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 phlo-health-check/1.0';

const args = process.argv.slice(2);
const host = (u) => new URL(u).hostname.replace(/^www\./, '');

async function get(url, { body = true } = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: res.status, url: res.url, text: body ? await res.text() : '' };
  } catch (e) {
    return { status: 0, url, text: '', error: e.cause?.code || e.name };
  }
}

const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);
const first = (re, s) => (s.match(re) || [])[1] ?? null;

function inspectPage(html) {
  return {
    title: first(/<title[^>]*>([^<]*)<\/title>/i, html)?.trim() ?? null,
    htmlLang: first(/<html[^>]*\blang="([^"]*)"/i, html),
    canonicals: all(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/gi, html),
    hreflang: (html.match(/<link[^>]*hreflang=[^>]*>/gi) || []).map((tag) => ({
      lang: first(/hreflang="([^"]*)"/i, tag),
      href: first(/href="([^"]*)"/i, tag),
    })),
    // Count only tags the browser will execute. Escaped JSON-LD inside a framework payload does not count.
    jsonLdTags: (html.match(/<script[^>]*type="application\/ld\+json"/gi) || []).length,
  };
}

async function sitemapUrls(base, cap = 5000) {
  const seen = [];
  const queue = [new URL('/sitemap.xml', base).href];
  while (queue.length && seen.length < cap) {
    const r = await get(queue.shift());
    if (r.status !== 200) continue;
    const locs = all(/<loc>\s*([^<\s]+)\s*<\/loc>/g, r.text);
    if (/<sitemapindex/i.test(r.text)) queue.push(...locs.slice(0, 20));
    else seen.push(...locs);
  }
  return seen.slice(0, cap);
}

function pick(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

async function scanProperty(p, sampleSize) {
  const home = await get(p.url);
  const probe = await get(new URL(`/phlo-probe-${Date.now().toString(36)}`, p.url).href);
  const locs = await sitemapUrls(p.url);
  const byHost = {};
  for (const l of locs) byHost[host(l)] = (byHost[host(l)] || 0) + 1;
  const statuses = {};
  for (const u of pick(locs, sampleSize)) {
    const s = (await get(u, { body: false })).status;
    statuses[s] = (statuses[s] || 0) + 1;
  }
  const page = inspectPage(home.text);
  const own = host(p.url);
  const probeTitle = first(/<title[^>]*>([^<]*)<\/title>/i, probe.text);
  const findings = [];
  const add = (severity, code, detail) => findings.push({ severity, code, detail });

  if (home.status !== 200) add('high', 'home-status', `Homepage returned HTTP ${home.status}`);
  if (probe.status === 200) add('high', 'soft-404', `Made-up URL returned HTTP 200 (title: "${probeTitle}")`);
  if (locs.length && !byHost[own]) add('high', 'sitemap-foreign-host', `0 of ${locs.length} sitemap URLs on ${own}; hosts: ${JSON.stringify(byHost)}`);
  if (!locs.length) add('medium', 'sitemap-missing', 'No URLs found at /sitemap.xml');
  const sampled = Object.values(statuses).reduce((a, b) => a + b, 0);
  const errors = Object.entries(statuses).filter(([s]) => +s >= 500).reduce((a, [, n]) => a + n, 0);
  if (errors) add('high', 'sitemap-5xx', `${errors} of ${sampled} sampled sitemap URLs returned 5xx`);
  if (page.title && page.title.length < 12) add('high', 'weak-title', `Homepage <title> is "${page.title}"`);
  if (!page.canonicals.length) add('medium', 'no-canonical', 'No rel=canonical on homepage');
  if (!page.jsonLdTags) add('medium', 'no-structured-data', 'No rendered JSON-LD on homepage');
  return { ...p, finalUrl: home.url, status: home.status, ...page, probe: { status: probe.status, title: probeTitle }, sitemap: { count: locs.length, byHost }, sampleStatuses: statuses, findings };
}

function checkPairs(results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return PAIRS.map(([a, b]) => {
    const A = byId[a], B = byId[b];
    const refs = (X, Y) => X.hreflang.some((h) => { try { return host(h.href) === host(Y.url); } catch { return false; } });
    return { pair: [a, b], aRefsB: refs(A, B), bRefsA: refs(B, A), aLang: A.htmlLang, bLang: B.htmlLang };
  });
}

function diff(oldPath, newPath) {
  const o = JSON.parse(readFileSync(oldPath, 'utf8')), n = JSON.parse(readFileSync(newPath, 'utf8'));
  console.log(`Re-check: ${o.ranAt} -> ${n.ranAt}\n`);
  for (const np of n.properties) {
    const op = o.properties.find((p) => p.id === np.id) || { findings: [] };
    const key = (f) => f.code;
    const fixed = op.findings.filter((f) => !np.findings.some((g) => key(g) === key(f)));
    const added = np.findings.filter((f) => !op.findings.some((g) => key(g) === key(f)));
    const still = np.findings.filter((f) => op.findings.some((g) => key(g) === key(f)));
    console.log(`${np.id.padEnd(16)} fixed ${fixed.length}  new ${added.length}  open ${still.length}`);
    fixed.forEach((f) => console.log(`   FIXED  ${f.code}`));
    added.forEach((f) => console.log(`   NEW    ${f.code}: ${f.detail}`));
  }
}

if (args[0] === '--diff') {
  diff(args[1], args[2]);
} else {
  const sampleSize = args.includes('--sample') ? +args[args.indexOf('--sample') + 1] : 30;
  const properties = [];
  for (const p of PROPERTIES) {
    process.stderr.write(`scanning ${p.id}...\n`);
    properties.push(await scanProperty(p, sampleSize));
  }
  const out = { ranAt: new Date().toISOString(), sampleSize, properties, hreflangPairs: checkPairs(properties) };
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const file = new URL(`./out/health-${out.ranAt.slice(0, 10)}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out, null, 2));
  for (const p of properties) {
    console.log(`\n${p.id} (${p.platform}) ${p.status} title="${p.title}" lang=${p.htmlLang} canonical=${p.canonicals.length} hreflang=${p.hreflang.length} jsonld=${p.jsonLdTags}`);
    console.log(`  sitemap ${p.sitemap.count} URLs ${JSON.stringify(p.sitemap.byHost)}  sample ${JSON.stringify(p.sampleStatuses)}  probe ${p.probe.status}`);
    p.findings.forEach((f) => console.log(`  [${f.severity}] ${f.code}: ${f.detail}`));
  }
  console.log('\nhreflang pairs:');
  out.hreflangPairs.forEach((x) => console.log(`  ${x.pair.join(' <-> ')}: ${x.aRefsB ? 'yes' : 'NO'} / ${x.bRefsA ? 'yes' : 'NO'}  (html lang ${x.aLang} / ${x.bLang})`));
  console.log(`\nwrote ${file.pathname}`);
}
