#!/usr/bin/env node
// Classic SEO audit, Australia: domain footprint, backlinks, ranked keywords, keyword gap, search volume.
//
//   node scan/seo-audit.mjs                     # dry run: plan + estimate, spends nothing
//   node scan/seo-audit.mjs --confirm --budget 6
//
// DataForSEO Labs + Keywords Data + Backlinks, fixed allowlist, hard budget. Keys from .env.
// Node 20.12+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keys come from .env at the repo root (git-ignored; see .env.example). Real env vars win.
try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}

const API = 'https://api.dataforseo.com/v3/';
const LOC = { location_code: 2036, language_code: 'en' }; // Australia
// Costs measured on this account, Oct 2026; ranked_keywords scales with rows returned.
const EST = { overview: 0.013, backlinks: 0.025, ranked: 0.16, volume: 0.09 };

const VITACO = { Musashi: 'musashi.com', 'Nutra-Life': 'nutralife.com.au', Healtheries: 'healtheries.com.au', 'Healtheries NZ': 'healtheries.co.nz', 'Aussie Bodies': 'aussiebodies.com' };
const RIVALS = { 'Bulk Nutrients': 'bulknutrients.com.au', 'True Protein': 'trueprotein.com.au', VPA: 'vpa.com.au', Swisse: 'swisse.com.au', Blackmores: 'blackmores.com.au' };
const ALL = { ...VITACO, ...RIVALS };

const TRACKED = [
  'best protein powder australia', 'is creatine safe to take daily', 'pre workout without caffeine australia', 'best creatine australia',
  'best magnesium for sleep australia', 'best probiotic australia', 'kids multivitamin australia', 'best protein bars australia',
  'best pre workout australia', 'high protein snacks australia',
];
const BRAND_TERMS = ['musashi', 'nutra life', 'nutralife', 'healtheries', 'aussie bodies', 'bulk nutrients', 'true protein', 'vpa', 'swisse', 'blackmores', 'optimum nutrition', 'ehp labs'];

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const budget = args.includes('--budget') ? +args[args.indexOf('--budget') + 1] : 6;

const jobs = [];
for (const [name, domain] of Object.entries(ALL)) {
  jobs.push({ kind: 'overview', name, domain, path: 'dataforseo_labs/google/domain_rank_overview/live', body: { target: domain, ...LOC } });
  jobs.push({ kind: 'backlinks', name, domain, path: 'backlinks/summary/live', body: { target: domain } });
  // Vitaco: everything it ranks for (top 1000 by volume). Rivals: only what they rank top 10 for.
  const rivals = !(name in VITACO);
  jobs.push({ kind: 'ranked', name, domain, path: 'dataforseo_labs/google/ranked_keywords/live', body: {
    target: domain, ...LOC, limit: 1000, order_by: ['keyword_data.keyword_info.search_volume,desc'],
    ...(rivals ? { filters: [['ranked_serp_element.serp_item.rank_group', '<=', 10]] } : {}),
  } });
}
jobs.push({ kind: 'volume', path: 'keywords_data/google_ads/search_volume/live', body: { keywords: [...TRACKED, ...BRAND_TERMS], ...LOC } });

const estimate = jobs.reduce((s, j) => s + EST[j.kind], 0);
console.log(`${jobs.length} calls, est. $${estimate.toFixed(2)} (budget $${budget})`);
if (estimate > budget) { console.error('Estimate exceeds budget.'); process.exit(1); }
if (!confirm) { console.log('Dry run. Re-run with --confirm to spend.'); process.exit(0); }
const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } = process.env;
if (!login || !password) { console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in .env.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

let spent = 0;
async function run(j) {
  if (spent + EST[j.kind] > budget) return { ...j, error: 'budget' };
  spent += EST[j.kind];
  try {
    const r = await fetch(API + j.path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify([j.body]), signal: AbortSignal.timeout(180000) });
    const d = await r.json();
    spent += (d.cost ?? EST[j.kind]) - EST[j.kind];
    const t = d.tasks?.[0];
    if (t?.status_code !== 20000) return { ...j, error: `${t?.status_code} ${t?.status_message}` };
    return { ...j, result: t.result };
  } catch (e) { return { ...j, error: e.name }; }
}
const results = [];
for (let i = 0; i < jobs.length; i += 5) {
  results.push(...(await Promise.all(jobs.slice(i, i + 5).map(run))));
  process.stderr.write(`${Math.min(i + 5, jobs.length)}/${jobs.length}  $${spent.toFixed(3)}\n`);
}

const out = { ranAt: new Date().toISOString(), location: 'Australia', vitaco: VITACO, rivals: RIVALS, spent: 0, domains: {}, volume: {}, errors: [] };
for (const r of results) {
  if (r.error) { out.errors.push({ kind: r.kind, domain: r.domain, error: r.error }); continue; }
  const res = r.result?.[0] || {};
  if (r.kind === 'volume') { for (const v of r.result || []) out.volume[v.keyword] = { volume: v.search_volume, cpc: v.cpc, competition: v.competition }; continue; }
  const d = (out.domains[r.domain] ||= { name: r.name, vitaco: r.name in VITACO });
  if (r.kind === 'overview') d.organic = res.items?.[0]?.metrics?.organic || null;
  if (r.kind === 'backlinks') d.backlinks = { rank: res.rank, backlinks: res.backlinks, referringDomains: res.referring_domains };
  if (r.kind === 'ranked') {
    d.rankedTotal = res.total_count;
    d.keywords = (res.items || []).map((it) => {
      const kd = it.keyword_data, se = it.ranked_serp_element?.serp_item || {};
      return { keyword: kd.keyword, volume: kd.keyword_info?.search_volume ?? 0, cpc: kd.keyword_info?.cpc ?? null,
        intent: kd.search_intent_info?.main_intent ?? null, rank: se.rank_group, url: se.relative_url || se.url, type: se.type };
    });
  }
}
out.spent = +spent.toFixed(4);
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/seo-audit-${out.ranAt.slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));

console.log('\nDomain                 keywords  top3   top10   est. traffic/mo  ref. domains');
for (const [dom, d] of Object.entries(out.domains)) {
  const o = d.organic || {};
  const top3 = (o.pos_1 || 0) + (o.pos_2_3 || 0), top10 = top3 + (o.pos_4_10 || 0);
  console.log(`${(d.vitaco ? '* ' : '  ') + dom.padEnd(22)} ${String(o.count ?? '-').padStart(7)} ${String(top3).padStart(6)} ${String(top10).padStart(7)} ${String(Math.round(o.etv || 0)).padStart(16)} ${String(d.backlinks?.referringDomains ?? '-').padStart(13)}`);
}
console.log('\nSearch volume:'); for (const [k, v] of Object.entries(out.volume)) console.log(`  ${k.padEnd(42)} ${v.volume}`);
if (out.errors.length) console.log('\nErrors:', out.errors);
console.log(`\nSpent $${spent.toFixed(4)}. Wrote ${fileURLToPath(file)}`);
