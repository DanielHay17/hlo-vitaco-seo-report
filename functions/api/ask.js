// Cloudflare Pages Function: POST /api/ask asks the big four models one question, live, during a demo.
// Needs two secrets in the Pages project (Settings → Variables and Secrets):
//   OPENROUTER_API_KEY  a dedicated OpenRouter key with a low credit limit (e.g. $5)
//   DEMO_PASSCODE       anything; typed into the page to use the live panel
// Without both, GET reports enabled:false and the page keeps the section hidden.

const MODELS = {
  Claude: 'anthropic/claude-sonnet-5.5',
  ChatGPT: 'openai/gpt-6.1-sol',
  Gemini: 'google/gemini-3.1-pro-preview',
  Grok: 'x-ai/grok-4.7',
};
// Keep in step with scan/ai-prompts.json. `match` is the text highlighted on the page.
const BRANDS = [
  ['Musashi', true, ['musashi']], ['Nutra-Life', true, ['nutra-life', 'nutralife', 'nutra life']],
  ['Healtheries', true, ['healtheries']], ['Aussie Bodies', true, ['aussie bodies']],
  ['Bulk Nutrients', false, ['bulk nutrients']], ['VPA', false, ['vpa']], ['True Protein', false, ['true protein']],
  ['Optimum Nutrition', false, ['optimum nutrition', 'gold standard whey']], ['EHP Labs', false, ['ehp labs', 'oxywhey', 'oxyshred']],
  ['Macro Mike', false, ['macro mike']], ['Body Science', false, ['body science']], ['Swisse', false, ['swisse']],
  ['Blackmores', false, ['blackmores']], ['Bioglan', false, ['bioglan']], ['Life-Space', false, ['life-space', 'life space']],
  ['Inner Health', false, ['inner health']], ["Nature's Way", false, ["nature's way", 'natures way']],
  ['Ethical Nutrients', false, ['ethical nutrients']], ['Metagenics', false, ['metagenics']], ['Myprotein', false, ['myprotein']],
  ['Muscle Nation', false, ['muscle nation']], ['Barebells', false, ['barebells']], ['Quest', false, ['quest bar', 'quest nutrition']],
  ['Fulfil', false, ['fulfil']], ['Up&Go', false, ['up&go', 'up & go']], ['Sustagen', false, ['sustagen']], ['Gatorade', false, ['gatorade']],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function brandsIn(text) {
  const found = [];
  for (const [name, vitaco, aliases] of BRANDS) {
    const m = text.match(new RegExp(`\\b(${aliases.map(esc).join('|')})\\b`, 'i'));
    if (m) found.push({ name, vitaco, match: m[1], at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map(({ at, ...b }) => b);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Constant-time compare so the passcode can't be guessed by timing.
function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export const onRequestGet = ({ env }) => json({ enabled: Boolean(env.OPENROUTER_API_KEY && env.DEMO_PASSCODE) });

export async function onRequestPost({ request, env }) {
  if (!env.OPENROUTER_API_KEY || !env.DEMO_PASSCODE) return json({ error: 'Live panel is not configured.' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!same(String(body.passcode || ''), env.DEMO_PASSCODE)) return json({ error: 'Wrong passcode.' }, 401);
  const question = String(body.question || '').trim();
  if (question.length < 3 || question.length > 300) return json({ error: 'Ask a question between 3 and 300 characters.' }, 400);

  const ask = async ([name, model]) => {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'Phlo live demo' },
        body: JSON.stringify({
          model, max_tokens: 900, reasoning: { effort: 'low' }, usage: { include: true },
          plugins: [{ id: 'web', max_results: 5 }],
          messages: [{ role: 'system', content: 'The user is in Sydney, Australia. Keep the answer under 250 words.' }, { role: 'user', content: question }],
        }),
        signal: AbortSignal.timeout(60000),
      });
      const d = await r.json();
      if (d.error) return { model: name, brands: [], error: 'This model did not answer. Try again.' };
      const text = d.choices?.[0]?.message?.content || '';
      return { model: name, text, brands: brandsIn(text), cost: d.usage?.cost ?? null };
    } catch {
      return { model: name, brands: [], error: 'This model timed out. Try again.' };
    }
  };
  const results = await Promise.all(Object.entries(MODELS).map(ask));
  return json({ question, results });
}
