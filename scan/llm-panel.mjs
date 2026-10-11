#!/usr/bin/env node
// Ask the big four models (Claude, ChatGPT, Gemini, Grok) the questions real shoppers ask, via OpenRouter.
// Two modes per question: "memory" (no web, what the model already believes) and "web" (it searches first).
//
//   node scan/llm-panel.mjs                       # dry run: plan + estimate, spends nothing
//   OPENROUTER_API_KEY=... node scan/llm-panel.mjs --confirm --budget 5
//
// API answers aren't identical to the consumer apps (no account history, different system prompt), so
// treat this as a model-level read. The DataForSEO scrapers in visibility.mjs capture the consumer apps.
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keys come from .env at the repo root (git-ignored; see .env.example). Real env vars win.
try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch {}


// Current flagship IDs on OpenRouter, Oct 2026. Check https://openrouter.ai/api/v1/models before changing.
const MODELS = {
  Claude: 'anthropic/claude-sonnet-5.5',
  ChatGPT: 'openai/gpt-6.1-sol',
  Gemini: 'google/gemini-3.1-pro-preview',
  Grok: 'x-ai/grok-4.7',
};
const QUESTIONS = [
  "I'm training a few times a week, what pre workout should I buy?",
  'I want to gain muscle, what should I take?',
  'What protein powder should I buy?',
  'Should I take creatine? Which one should I get?',
  "I'm cutting weight but want to keep my muscle, what supplements help?",
  "What's a good recovery drink after training?",
  "I'm not sleeping well, what magnesium should I take?",
  "What's a good probiotic for gut health?",
  'What vitamins should I give my kids?',
  "What's a healthy protein bar I can grab on the go?",
];
// Consumer apps know roughly where you are; the API doesn't, so say it once.
const SYSTEM = 'The user is in Sydney, Australia.';
const EST = 0.03; // per call, generous; OpenRouter's reported cost is what's tracked

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const budget = args.includes('--budget') ? +args[args.indexOf('--budget') + 1] : 5;
const cfg = JSON.parse(readFileSync(new URL('./ai-prompts.json', import.meta.url), 'utf8'));

const jobs = [];
for (const q of QUESTIONS) for (const [name, model] of Object.entries(MODELS)) for (const mode of ['memory', 'web']) jobs.push({ q, name, model, mode });
console.log(`${jobs.length} calls, est. up to $${(jobs.length * EST).toFixed(2)} (budget $${budget})`);
if (jobs.length * EST > budget * 2) { console.error('Estimate far exceeds budget.'); process.exit(1); }
if (!confirm) { console.log('Dry run. Re-run with --confirm to spend.'); process.exit(0); }
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('Set OPENROUTER_API_KEY.'); process.exit(1); }

let spent = 0;
async function run(j) {
  if (spent + EST > budget) return { ...j, error: 'budget' };
  spent += EST;
  const body = {
    model: j.model, max_tokens: 1500, usage: { include: true }, reasoning: { effort: 'low' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: j.q }],
    ...(j.mode === 'web' ? { plugins: [{ id: 'web', max_results: 5 }] } : {}),
  };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Phlo visibility panel' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    });
    const d = await r.json();
    spent += (d.usage?.cost ?? EST) - EST;
    if (d.error) return { ...j, error: d.error.message || String(d.error.code) };
    const m = d.choices?.[0]?.message || {};
    return { ...j, text: m.content || '', citations: (m.annotations || []).map((a) => a.url_citation?.url).filter(Boolean), cost: d.usage?.cost };
  } catch (e) { return { ...j, error: e.name }; }
}

const results = [];
for (let i = 0; i < jobs.length; i += 6) {
  results.push(...(await Promise.all(jobs.slice(i, i + 6).map(run))));
  process.stderr.write(`${Math.min(i + 6, jobs.length)}/${jobs.length}  $${spent.toFixed(3)}\n`);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandRes = Object.entries(cfg.brands).map(([n, b]) => [n, new RegExp(`\\b(${b.aliases.map(esc).join('|')})\\b`, 'i')]);
const vitaco = new Set(Object.entries(cfg.brands).filter(([, b]) => b.vitaco).map(([n]) => n));
for (const r of results) {
  if (!r.text) continue;
  // Order of first appearance: the first brand named is the one a shopper is most likely to act on.
  const hits = brandRes.map(([n, re]) => [n, r.text.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  r.brands = hits.map(([n]) => n);
  r.vitaco = r.brands.filter((b) => vitaco.has(b));
  r.citedDomains = [...new Set(r.citations.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))];
}

const ok = results.filter((r) => r.text);
const summary = {};
for (const name of Object.keys(MODELS)) for (const mode of ['memory', 'web']) {
  const rs = ok.filter((r) => r.name === name && r.mode === mode);
  summary[`${name} ${mode}`] = { answers: rs.length, vitaco: rs.filter((r) => r.vitaco.length).length, anyBrand: rs.filter((r) => r.brands.length).length };
}
const sov = {};
for (const r of ok) for (const b of new Set(r.brands)) sov[b] = (sov[b] || 0) + 1;

const out = { ranAt: new Date().toISOString(), spent: +spent.toFixed(4), models: MODELS, system: SYSTEM, summary,
  shareOfVoice: Object.entries(sov).sort((a, b) => b[1] - a[1]), results, errors: results.filter((r) => r.error).map(({ q, name, mode, error }) => ({ q, name, mode, error })) };
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/llm-panel-${out.ranAt.slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));

for (const q of QUESTIONS) {
  console.log(`\n"${q}"`);
  for (const r of ok.filter((x) => x.q === q)) console.log(`  ${(r.name + ' ' + r.mode).padEnd(15)} ${r.vitaco.length ? 'VITACO ' + r.vitaco.join('/') : '      -'}  ${r.brands.slice(0, 5).join(', ') || '(no brands)'}`);
}
console.log('\nSummary (answers naming a Vitaco brand / answers naming any brand / answers):');
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(15)} ${v.vitaco} / ${v.anyBrand} / ${v.answers}`);
console.log('\nShare of voice:', out.shareOfVoice.slice(0, 15).map(([b, n]) => `${b} ${n}`).join(', '));
if (out.errors.length) console.log(`\n${out.errors.length} errors`, out.errors.slice(0, 6));
console.log(`\nSpent $${spent.toFixed(4)}. Wrote ${file.pathname}`);
