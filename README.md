# Vitaco search health report (Phlo)

Client-facing report for Dhiren Dunraj, Vitaco Health. Meeting: Wed 14 Oct 2026, 11am.

```
site/              static report (the only public directory). Swap site/assets/phlo-logo.png for your logo.
functions/api/ask.js   optional live "ask all four models" panel (Cloudflare Pages Function)
scan/              the "Find" and "Re-check" steps of the loop
  health-check.mjs     plain HTTP checks across all six sites, $0
  ai-crawlers.mjs      robots.txt rules for AI crawlers + llms.txt, Vitaco vs competitors, $0
  agent-readiness.mjs  how easy each store is for an AI shopping agent (incl. Shopify /api/mcp), $0
  visibility.mjs       DataForSEO: consumer ChatGPT, Gemini, Google AI Mode, Google search, AIO citations
  llm-panel.mjs        OpenRouter: Claude, ChatGPT, Gemini, Grok x 10 natural questions x memory/web
  ai-prompts.json      questions, searches and brand list
  baseline/            dated output from 11 Oct 2026, the "before" for the monthly re-check
```

## Keys

```bash
cp .env.example .env    # then fill in DataForSEO and OpenRouter keys
```

`.env` is git-ignored. `visibility.mjs` and `llm-panel.mjs` load it automatically (Node 20.12+);
real environment variables take precedence. Cloudflare doesn't read `.env`: the live panel's
keys go in the Pages project as secrets (below).

## Deploy to Cloudflare Pages

No build step.

**Git integration (recommended):** Cloudflare dashboard → Workers & Pages → Create → Pages →
Connect to Git → pick this repo. Framework preset: *None*. Build command: *(empty)*.
Build output directory: `site`. Every push to `main` redeploys.

**Direct upload, no Git:**

```bash
npx wrangler pages deploy site --project-name vitaco-search-health
```

**Live panel (optional, for the demo):** in the Pages project, Settings → Variables and Secrets, add
two *secrets*: `OPENROUTER_API_KEY` (create a separate OpenRouter key with a ~$5 credit limit for this)
and `DEMO_PASSCODE`. Redeploy. The "Ask your own question" section appears only when both are set.
Each question asks all four models with web search: about $0.09 and ~12 seconds. Without the
secrets, the section stays hidden and the page is fully static.

The site sends `noindex` (via `_headers` and `robots.txt`), but anyone with the link can open it.
To restrict it to named emails, add Cloudflare Access (Zero Trust → Access → Applications →
self-hosted, domain `vitaco-search-health.pages.dev`, policy: emails `dhiren.dunraj@vitaco.com.au` plus yours).

## Run the scan

```bash
node scan/health-check.mjs                    # writes scan/out/health-<date>.json
node scan/health-check.mjs --diff scan/baseline/health-2026-10-11.json scan/out/health-<date>.json
```

Behind a proxy: prefix with `NODE_USE_ENV_PROXY=1`.

## DataForSEO

```bash
node scan/visibility.mjs                          # dry run: plan + estimated cost, spends nothing
node scan/visibility.mjs --confirm --budget 0.5           # keys from .env
node scan/visibility.mjs --confirm --only mentions   # one part only; writes its own file
```

Credentials come from `.env` (or real environment variables). Never commit them.

Measured cost per call on this account (Oct 2026): ChatGPT scraper $0.004, Gemini scraper $0.004,
Google AI Mode $0.004, Google organic $0.002, LLM Mentions multi-target $0.11. A full run is about
$0.32. The whole report, including test calls, cost $0.875.

Guardrails, because the official MCP server (`dataforseo/mcp-server-typescript`, default branch
`master`) exposes a generic `api_request` tool that will hit any endpoint with no allowlist:

- A fixed allowlist of five endpoints, Australia only.
- Refuses Google keywords containing search operators (`site:`, `inurl:`, quotes, `-term`, `OR`),
  since each operator bills as an extra SERP.
- Aborts if the estimate exceeds `--budget`, and stops mid-run using the API's reported `cost`.

LLM Mentions gotcha: several domains inside one `target` must *all* match, which undercounts. The
script uses one domain per brand.

If you also use the MCP server interactively in Claude Code, require approval for the passthrough:
add `"mcp__dataforseo__api_request"` to `permissions.ask` in `.claude/settings.json`.

## OpenRouter

```bash
node scan/llm-panel.mjs                                   # dry run
node scan/llm-panel.mjs --confirm --budget 5              # key from .env
```

80 calls (10 questions x 4 models x memory/web) cost $1.52 on 11 Oct 2026. Model IDs are pinned
at the top of the script and in `functions/api/ask.js`; check https://openrouter.ai/api/v1/models
before changing them. API answers can differ from the consumer apps, which `visibility.mjs` covers.
