#!/usr/bin/env node
// Where do Vitaco's brands show up when Australians ask Google and AI assistants what to buy?
//
//   node scan/visibility.mjs                       # dry run: plan + estimated cost, spends nothing
//   node scan/visibility.mjs --confirm             # spend (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)
//   node scan/visibility.mjs --confirm --budget 1 --runs 3
//
// Calls a fixed allowlist of DataForSEO endpoints with a hard budget. Deliberately not the MCP server:
// its generic api_request tool will call any endpoint an agent asks for. Config: scan/ai-prompts.json.
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const API = 'https://api.dataforseo.com/v3/';
// Per-call costs measured on this account, Oct 2026. The API's reported cost is what's tracked once running.
const ENDPOINTS = {
  chatgpt:  { path: 'ai_optimization/chat_gpt/llm_scraper/live/advanced', est: 0.004 },
  gemini:   { path: 'ai_optimization/gemini/llm_scraper/live/advanced',   est: 0.004 },
  ai_mode:  { path: 'serp/google/ai_mode/live/advanced',                  est: 0.004 },
  organic:  { path: 'serp/google/organic/live/advanced',                  est: 0.002 },
  mentions: { path: 'ai_optimization/llm_mentions/multi_target_metrics/live', est: 0.15 },
};

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? +args[args.indexOf(n) + 1] : d);
const confirm = args.includes('--confirm');
const budget = flag('--budget', 1);
const runs = flag('--runs', 3);          // ChatGPT answers vary run to run, so ask more than once
const geminiRuns = flag('--gemini-runs', 2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null; // e.g. --only mentions

const cfg = JSON.parse(readFileSync(new URL('./ai-prompts.json', import.meta.url), 'utf8'));
const loc = { location_code: cfg.location_code, language_code: cfg.language_code };

// Search operators bill as extra SERPs; refuse them in organic keywords.
const OPERATOR = /(^|\s)(site|inurl|intitle|allintitle|allinurl|intext|related|filetype|cache):|"|\s-\w|\sOR\s|\|/i;
const badKw = cfg.keywords.filter((k) => OPERATOR.test(k));
if (badKw.length) { console.error(`Refusing: search operators in ${JSON.stringify(badKw)}`); process.exit(1); }

const jobs = [];
for (const p of cfg.prompts) {
  for (let i = 0; i < runs; i++) jobs.push({ kind: 'chatgpt', prompt: p, body: { keyword: p.q, ...loc, force_web_search: true } });
  for (let i = 0; i < geminiRuns; i++) jobs.push({ kind: 'gemini', prompt: p, body: { keyword: p.q, ...loc } });
  jobs.push({ kind: 'ai_mode', prompt: p, body: { keyword: p.q, ...loc } });
}
for (const k of cfg.keywords) jobs.push({ kind: 'organic', keyword: k, body: { keyword: k, ...loc, device: 'desktop', depth: 10, load_async_ai_overview: true } });
const targets = cfg.mentions_targets.map((name) => ({
  key: name,
  // One domain per target: several entities in one target must ALL match, which undercounts.
  target: [{ domain: cfg.brands[name].domains[0], search_filter: 'include', include_subdomains: true }],
}));
jobs.push({ kind: 'mentions', body: { targets, ...loc, platform: 'google' } });
if (only) jobs.splice(0, jobs.length, ...jobs.filter((j) => only.includes(j.kind)));

const estimate = jobs.reduce((s, j) => s + ENDPOINTS[j.kind].est, 0);
const counts = jobs.reduce((m, j) => ((m[j.kind] = (m[j.kind] || 0) + 1), m), {});
console.log(`${jobs.length} calls ${JSON.stringify(counts)} est. $${estimate.toFixed(3)} (budget $${budget})`);
if (estimate > budget) { console.error('Estimate exceeds budget.'); process.exit(1); }
if (!confirm) { console.log('Dry run. Re-run with --confirm to spend.'); process.exit(0); }

const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } = process.env;
if (!login || !password) { console.error('Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

let spent = 0;
async function run(job) {
  const ep = ENDPOINTS[job.kind];
  if (spent + ep.est > budget) return { ...job, error: 'budget' };
  spent += ep.est; // reserve, then true up with the reported cost
  try {
    const res = await fetch(API + ep.path, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify([job.body]), signal: AbortSignal.timeout(180000),
    });
    const json = await res.json();
    spent += (json.cost ?? ep.est) - ep.est;
    const task = json.tasks?.[0];
    if (task?.status_code !== 20000) return { ...job, error: `${task?.status_code} ${task?.status_message}` };
    return { ...job, result: task.result?.[0] ?? null };
  } catch (e) {
    return { ...job, error: e.name };
  }
}

// Live AI calls take up to 2 minutes each, so run a few at a time.
const results = [];
for (let i = 0; i < jobs.length; i += 6) {
  results.push(...(await Promise.all(jobs.slice(i, i + 6).map(run))));
  process.stderr.write(`${Math.min(i + 6, jobs.length)}/${jobs.length} calls, $${spent.toFixed(3)}\n`);
}

// ---- analysis ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandRes = Object.entries(cfg.brands).map(([name, b]) => [name, new RegExp(`\\b(${b.aliases.map(esc).join('|')})\\b`, 'i')]);
const brandsIn = (text) => brandRes.filter(([, re]) => re.test(text)).map(([n]) => n);
const vitaco = new Set(Object.entries(cfg.brands).filter(([, b]) => b.vitaco).map(([n]) => n));
const bare = (d) => (d || '').replace(/^www\./, '');
const domainBrand = (d) => Object.entries(cfg.brands).find(([, b]) => b.domains.some((x) => bare(d) === x || bare(d).endsWith('.' + x)))?.[0];

function answerOf(r) {
  if (r.kind === 'ai_mode') {
    const aio = (r.result?.items || []).find((i) => i.type === 'ai_overview');
    return { text: aio?.markdown || '', sources: (aio?.references || []).map((x) => bare(x.domain)) };
  }
  const res = r.result || {};
  const sources = [...(res.sources || []), ...(res.search_results || [])].map((s) => bare(s.domain)).filter(Boolean);
  return { text: res.markdown || '', sources, fanOut: res.fan_out_queries || [] };
}

const ai = cfg.prompts.map((p) => {
  const bySurface = {};
  for (const kind of ['chatgpt', 'gemini', 'ai_mode']) {
    const rs = results.filter((r) => r.kind === kind && r.prompt === p && r.result);
    const answers = rs.map(answerOf).map((a) => ({ ...a, brands: brandsIn(a.text) }));
    bySurface[kind] = {
      runs: answers.length,
      targetHits: answers.filter((a) => a.brands.includes(p.brand)).length,
      vitacoHits: answers.filter((a) => a.brands.some((b) => vitaco.has(b))).length,
      brands: Object.entries(answers.flatMap((a) => a.brands).reduce((m, b) => ((m[b] = (m[b] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
      sources: [...new Set(answers.flatMap((a) => a.sources))],
      fanOut: [...new Set(answers.flatMap((a) => a.fanOut || []))],
    };
  }
  return { q: p.q, brand: p.brand, bySurface };
});

const organic = results.filter((r) => r.kind === 'organic').map((r) => {
  const items = r.result?.items || [];
  const top = items.filter((i) => i.type === 'organic').map((i) => ({ rank: i.rank_group, domain: bare(i.domain), brand: domainBrand(i.domain) || null }));
  const aio = items.find((i) => i.type === 'ai_overview');
  const aioText = aio ? JSON.stringify(aio) : '';
  return {
    keyword: r.keyword, error: r.error || null, top,
    aiOverview: aio ? { refs: [...new Set((aio.references || []).map((x) => bare(x.domain)))], brands: brandsIn(aioText) } : null,
    vitacoOrganic: top.filter((t) => vitaco.has(t.brand)),
  };
});

const mentionsRes = results.find((r) => r.kind === 'mentions');
const mentions = (mentionsRes?.result?.items || []).map((i) => ({ key: i.key, domain: cfg.brands[i.key]?.domains[0], mentions: i.total?.mentions ?? 0, aiSearchVolume: i.total?.ai_search_volume ?? 0 }));

// Which sites do the AI answers read? That list is where to earn a mention.
const sourceCounts = {};
for (const a of ai) for (const s of Object.values(a.bySurface)) for (const d of s.sources) sourceCounts[d] = (sourceCounts[d] || 0) + 1;
for (const o of organic) for (const d of o.aiOverview?.refs || []) sourceCounts[d] = (sourceCounts[d] || 0) + 1;
const topSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);

const out = { ranAt: new Date().toISOString(), spent: +spent.toFixed(4), runs, geminiRuns, ai, organic, mentions, topSources,
  errors: results.filter((r) => r.error).map((r) => ({ kind: r.kind, q: r.prompt?.q || r.keyword, error: r.error })) };
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/visibility-${out.ranAt.slice(0, 10)}${only ? '-' + only.join('-') : ''}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));

for (const a of ai) {
  console.log(`\n"${a.q}"  (target: ${a.brand})`);
  for (const [k, s] of Object.entries(a.bySurface)) console.log(`  ${k.padEnd(8)} ${a.brand} ${s.targetHits}/${s.runs}  top: ${s.brands.slice(0, 5).map(([b, n]) => `${b}(${n})`).join(', ') || '-'}`);
}
console.log('\nGoogle organic (AU):');
for (const o of organic) console.log(`  ${o.keyword.padEnd(40)} Vitaco: ${o.vitacoOrganic.map((v) => `#${v.rank} ${v.brand}`).join(', ') || '-'}  AIO: ${o.aiOverview ? (o.aiOverview.brands.join(', ') || 'no brands') : 'none'}`);
console.log('\nGoogle AI Overview mentions:'); mentions.forEach((m) => console.log(`  ${String(m.key).padEnd(16)} ${JSON.stringify(m)}`));
console.log('\nMost-cited sources:'); topSources.slice(0, 15).forEach(([d, n]) => console.log(`  ${d.padEnd(36)} ${n}`));
if (out.errors.length) console.log(`\n${out.errors.length} errors`, out.errors.slice(0, 5));
console.log(`\nSpent $${spent.toFixed(4)}. Wrote ${file.pathname}`);
