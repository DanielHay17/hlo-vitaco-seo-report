#!/usr/bin/env node
// How easy is each store for an AI shopping agent? Plain HTTP + Shopify's public Storefront MCP endpoint, $0.
//
//   node scan/agent-readiness.mjs              # writes scan/out/agent-readiness-<date>.json
//   node scan/agent-readiness.mjs --tries 3    # attempts per agent question (answers vary run to run)
//
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { writeFileSync, mkdirSync } from 'node:fs';

const SITES = [
  { name: 'Musashi', base: 'https://musashi.com', vitaco: true, q: 'protein' },
  { name: 'Nutra-Life AU', base: 'https://nutralife.com.au', vitaco: true, q: 'magnesium' },
  { name: 'Nutra-Life NZ', base: 'https://www.nutralife.co.nz', vitaco: true, q: 'magnesium' },
  { name: 'Healtheries AU', base: 'https://healtheries.com.au', vitaco: true, q: 'kids' },
  { name: 'Healtheries NZ', base: 'https://healtheries.co.nz', vitaco: true, q: 'kids' },
  { name: 'Aussie Bodies', base: 'https://aussiebodies.com', vitaco: true, q: 'bar' },
  { name: 'True Protein', base: 'https://www.trueprotein.com.au', q: 'protein' },
  { name: 'Bulk Nutrients', base: 'https://www.bulknutrients.com.au', q: 'protein' },
  { name: 'VPA', base: 'https://www.vpa.com.au', q: 'protein' },
  { name: 'Swisse', base: 'https://www.swisse.com.au', q: 'magnesium' },
  { name: 'Blackmores', base: 'https://www.blackmores.com.au', q: 'magnesium' },
];
// Shopper questions an agent would put to the store itself.
const QUESTIONS = {
  protein: ["What's the best protein powder for muscle recovery?", 'How much protein per serve, and is it third party tested?'],
  magnesium: ['Which magnesium is best for sleep?', 'Is it safe to take magnesium every night?'],
  kids: ['Which multivitamin is best for kids?', 'What age is your kids multivitamin suitable for?'],
  bar: ["What's your healthiest protein bar?", 'How much sugar is in your protein bars?'],
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 phlo-health-check/1.0';
const args = process.argv.slice(2);
const tries = args.includes('--tries') ? +args[args.indexOf('--tries') + 1] : 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text(), url: r.url };
  } catch (e) { return { status: 0, type: '', text: '', error: e.cause?.code || e.name }; }
}
const mcp = (base, method, params) => req(base + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

// Find up to three live product pages (bundles and merch skipped): Shopify's products.json first, then the sitemap.
const SKIP = /bundle|stack|gift|shaker|bottle|t-shirt|beanie|mug|caddy|merch/i;
async function productUrls(base) {
  const pj = await req(base + '/products.json?limit=30');
  if (pj.status === 200 && pj.type.includes('json')) {
    try {
      const hs = JSON.parse(pj.text).products.map((p) => p.handle).filter((h) => !SKIP.test(h)).slice(0, 3);
      if (hs.length) return { urls: hs.map((h) => `${base}/products/${h}`), catalogue: 'products.json' };
    } catch {}
  }
  const queue = [base + '/sitemap.xml', base + '/sitemap_index.xml', base + '/product-sitemap.xml'];
  const seen = new Set(); const urls = [];
  while (queue.length && seen.size < 12 && urls.length < 3) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const r = await req(u); if (r.status !== 200) continue;
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    if (/<sitemapindex/i.test(r.text)) { queue.unshift(...locs.filter((l) => /product/i.test(l)), ...locs.filter((l) => !/product/i.test(l)).slice(0, 3)); continue; }
    // Singular /product/<handle> first: plural /products/<x> is often a category page.
    const cands = [...locs.filter((l) => /\/product\/[^/?#]+/i.test(l)), ...locs.filter((l) => /\/products\/[^/?#]+/i.test(l))]
      .filter((l) => !SKIP.test(l) && !/[?&]lang=/.test(l));
    for (const l of cands.slice(0, 10)) {
      if (urls.length >= 3) break;
      if ((await req(l, { method: 'HEAD' })).status === 200) urls.push(l);
    }
  }
  return { urls, catalogue: urls.length ? 'sitemap' : null };
}

function productSchema(html) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const nodes = [];
  const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { nodes.push(n); Object.values(n).forEach(walk); } };
  for (const b of blocks) { try { walk(JSON.parse(b)); } catch {} }
  const isProduct = (n) => [].concat(n['@type'] || []).some((t) => /^(Product|ProductGroup)$/.test(t));
  const p = nodes.find(isProduct);
  if (!p) return { product: false };
  const offers = nodes.filter((n) => [].concat(n['@type'] || []).includes('Offer') || n.price || n.lowPrice);
  const has = (re) => Object.keys(p).some((k) => re.test(k)) || nodes.filter(isProduct).some((x) => Object.keys(x).some((k) => re.test(k)));
  return {
    product: true,
    price: offers.some((o) => o.price || o.lowPrice || o.priceSpecification),
    availability: offers.some((o) => o.availability),
    gtin: has(/^gtin/i) || offers.some((o) => Object.keys(o).some((k) => /^gtin/i.test(k))),
    rating: has(/aggregateRating/i),
  };
}

const results = [];
for (const s of SITES) {
  process.stderr.write(`${s.name}...\n`);
  const prod = await productUrls(s.base);
  const schemas = [];
  for (const u of prod.urls) schemas.push(productSchema((await req(u)).text));
  const most = (f) => schemas.length > 0 && schemas.filter(f).length * 2 > schemas.length; // majority of sampled pages
  const schema = { sampled: schemas.length, product: most((x) => x.product && x.price && x.availability), gtin: most((x) => x.gtin), rating: most((x) => x.rating) };

  const list = await mcp(s.base, 'tools/list', {});
  let tools = [];
  try { tools = JSON.parse(list.text).result?.tools?.map((t) => t.name) || []; } catch {}
  const faq = { asked: 0, answered: 0, sample: null };
  if (tools.includes('search_shop_policies_and_faqs')) {
    for (const q of QUESTIONS[s.q]) for (let i = 0; i < tries; i++) {
      const r = await mcp(s.base, 'tools/call', { name: 'search_shop_policies_and_faqs', arguments: { query: q } });
      faq.asked++;
      try {
        const res = JSON.parse(r.text).result;
        const items = res?.isError ? [] : JSON.parse(res.content[0].text);
        // Shopify adds a stock "self-serve returns" answer to some stores; that isn't the brand's own content.
        const own = items.filter((x) => !/self-serve returns/i.test(x.question || ''));
        if (own.length) { faq.answered++; faq.sample ||= { q, a: own[0] }; }
      } catch {}
      await sleep(400);
    }
  }

  const robots = await req(s.base + '/robots.txt');
  const llms = await req(s.base + '/llms.txt');
  const checks = {
    productSchema: schema.product,
    gtin: !!schema.gtin,
    catalogue: !!prod.catalogue,
    agentEndpoint: tools.length > 0,
    agentAnswers: faq.answered > 0,
    llmsTxt: llms.status === 200 && !/<html/i.test(llms.text.slice(0, 500)),
  };
  results.push({ ...s, productUrls: prod.urls, catalogue: prod.catalogue, schema, tools, faq, robots: robots.status, checks,
    score: Object.values(checks).filter(Boolean).length, of: Object.keys(checks).length });
}

const out = { ranAt: new Date().toISOString(), tries, results };
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/agent-readiness-${out.ranAt.slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));
for (const r of results) {
  const c = r.checks;
  console.log(`${r.name.padEnd(15)} ${r.score}/${r.of}  schema:${c.productSchema ? 'Y' : '-'} gtin:${c.gtin ? 'Y' : '-'} catalogue:${r.catalogue || '-'} mcp:${r.tools.join('|') || '-'} answers:${r.faq.answered}/${r.faq.asked} llms:${c.llmsTxt ? 'Y' : '-'}  ${(r.productUrls || []).map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join(' ')}`);
}
console.log(`wrote ${file.pathname}`);
