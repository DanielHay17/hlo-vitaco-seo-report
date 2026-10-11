#!/usr/bin/env node
// Can AI assistants read the site? Checks robots.txt rules for the crawlers behind ChatGPT, Claude,
// Perplexity and Gemini, plus whether llms.txt exists. Plain HTTP, $0.
//
//   node scan/ai-crawlers.mjs
//
// Node 18+. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

const SITES = {
  Musashi: 'https://musashi.com', 'Nutra-Life AU': 'https://nutralife.com.au', 'Nutra-Life NZ': 'https://www.nutralife.co.nz',
  'Healtheries AU': 'https://healtheries.com.au', 'Healtheries NZ': 'https://healtheries.co.nz', 'Aussie Bodies': 'https://aussiebodies.com',
  'Bulk Nutrients': 'https://www.bulknutrients.com.au', VPA: 'https://www.vpa.com.au', 'True Protein': 'https://www.trueprotein.com.au',
  Swisse: 'https://www.swisse.com.au', Blackmores: 'https://www.blackmores.com.au',
};
// Search/retrieval bots decide whether a site can be cited in answers; training bots only affect future models.
const BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'Claude-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 phlo-health-check/1.0';

async function text(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: r.status === 200 ? await r.text() : '' };
  } catch { return { status: 0, body: '' }; }
}

// Minimal robots.txt evaluation for the site root: most specific matching group wins, else '*'.
function blocksRoot(robots, bot) {
  const groups = [];
  let cur = null;
  for (const raw of robots.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (k.toLowerCase() === 'user-agent') {
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
    } else if (cur) cur.rules.push({ allow: k.toLowerCase() === 'allow', path: v });
  }
  const pick = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
  const use = pick.length ? pick : groups.filter((g) => g.agents.includes('*'));
  const rules = use.flatMap((g) => g.rules);
  const disallowAll = rules.some((r) => !r.allow && r.path === '/');
  const allowAll = rules.some((r) => r.allow && r.path === '/');
  return { blocked: disallowAll && !allowAll, explicit: pick.length > 0 };
}

const rows = [];
for (const [name, base] of Object.entries(SITES)) {
  const robots = await text(base + '/robots.txt');
  const llms = await text(base + '/llms.txt');
  const bots = Object.fromEntries(BOTS.map((b) => [b, blocksRoot(robots.body, b)]));
  rows.push({ name, base, robots: robots.status, llmsTxt: llms.status === 200 && !/<html/i.test(llms.body), bots });
  const blocked = BOTS.filter((b) => bots[b].blocked);
  const named = BOTS.filter((b) => bots[b].explicit);
  console.log(`${name.padEnd(16)} robots ${robots.status}  llms.txt ${rows.at(-1).llmsTxt ? 'yes' : 'no '}  blocked: ${blocked.join(', ') || 'none'}  named: ${named.join(', ') || 'none'}`);
}
console.log(JSON.stringify({ ranAt: new Date().toISOString(), rows }));
