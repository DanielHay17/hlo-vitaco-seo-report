#!/usr/bin/env node
// Competitive gap: who owns page one for high-intent AU queries.
// Calls ONE fixed DataForSEO endpoint with a hard budget cap. Deliberately not the MCP server:
// its generic api_request tool will call any endpoint an agent asks for, with no allowlist.
//
//   node scan/serp-check.mjs                  # dry run: prints the plan and estimated cost, spends nothing
//   node scan/serp-check.mjs --confirm        # spend (needs DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)
//   node scan/serp-check.mjs --confirm --budget 0.25
//
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ENDPOINT = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced';
// Live Google organic, depth 10 = one SERP page. Check the current price in your DataForSEO dashboard;
// the script trusts the API's reported cost over this estimate once requests start.
const EST_COST_PER_SERP = 0.002;
const LOCATION_CODE = 2036; // Australia
const DEPTH = 10;

const VITACO = ['musashi.com', 'nutralife.com.au', 'nutralife.co.nz', 'healtheries.com.au', 'healtheries.co.nz', 'aussiebodies.com'];

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const budget = args.includes('--budget') ? +args[args.indexOf('--budget') + 1] : 0.5;

// Search operators multiply DataForSEO cost (each one bills as an extra SERP), so refuse them outright.
const OPERATOR = /(^|\s)(site|inurl|intitle|allintitle|allinurl|intext|related|filetype|cache):|"|\s-\w|\sOR\s|\|/i;

const keywords = readFileSync(new URL('./keywords.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const rejected = keywords.filter((k) => OPERATOR.test(k));
if (rejected.length) {
  console.error(`Refusing to run: search operators found in ${JSON.stringify(rejected)}`);
  process.exit(1);
}

const estimate = keywords.length * EST_COST_PER_SERP;
console.log(`${keywords.length} keywords x $${EST_COST_PER_SERP} = est. $${estimate.toFixed(4)} (budget $${budget.toFixed(2)})`);
if (estimate > budget) {
  console.error('Estimate exceeds budget. Raise --budget or trim keywords.txt.');
  process.exit(1);
}
if (!confirm) {
  keywords.forEach((k) => console.log(`  would query: ${k}`));
  console.log('Dry run only. Re-run with --confirm to spend.');
  process.exit(0);
}

const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } = process.env;
if (!login || !password) {
  console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
const domainOf = (d) => d.replace(/^www\./, '');

let spent = 0;
const results = [];
for (const keyword of keywords) {
  if (spent + EST_COST_PER_SERP > budget) {
    console.error(`Stopping: next request would pass the $${budget} budget (spent $${spent.toFixed(4)}).`);
    break;
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify([{ keyword, location_code: LOCATION_CODE, language_code: 'en', device: 'desktop', depth: DEPTH }]),
  });
  const json = await res.json();
  spent += json.cost ?? EST_COST_PER_SERP;
  const task = json.tasks?.[0];
  if (task?.status_code !== 20000) {
    console.error(`${keyword}: ${task?.status_code} ${task?.status_message}`);
    continue;
  }
  const organic = (task.result?.[0]?.items || []).filter((i) => i.type === 'organic');
  const top = organic.map((i) => ({ rank: i.rank_group, domain: domainOf(i.domain), url: i.url }));
  const vitaco = top.filter((t) => VITACO.includes(t.domain));
  results.push({ keyword, top, vitaco });
  console.log(`${keyword}\n  Vitaco: ${vitaco.length ? vitaco.map((v) => `#${v.rank} ${v.domain}`).join(', ') : 'not on page one'}\n  top 3: ${top.slice(0, 3).map((t) => t.domain).join(', ')}`);
}

// Page-one presence per domain across all keywords.
const presence = {};
for (const r of results) for (const d of new Set(r.top.map((t) => t.domain))) presence[d] = (presence[d] || 0) + 1;
const leaders = Object.entries(presence).sort((a, b) => b[1] - a[1]).slice(0, 10);
const vitacoHits = results.filter((r) => r.vitaco.length).length;

console.log(`\nVitaco on page one for ${vitacoHits} of ${results.length} queries`);
leaders.forEach(([d, n]) => console.log(`  ${d.padEnd(28)} ${n}/${results.length}`));
console.log(`\nActual spend reported by API: $${spent.toFixed(4)}`);

mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/serp-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), spent, location: 'Australia', results, presence }, null, 2));
console.log(`wrote ${file.pathname}`);
