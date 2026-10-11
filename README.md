# Vitaco search health report (Phlo)

Client-facing report for Dhiren Dunraj, Vitaco Health. Meeting: Wed 14 Oct 2026, 11am.

```
site/        static report, deployed to Cloudflare Pages (the only public directory)
scan/        the "Find" and "Re-check" steps of the loop
  health-check.mjs   plain HTTP checks across all six sites, $0 per run
  ai-crawlers.mjs    robots.txt rules for AI crawlers + llms.txt, Vitaco vs competitors, $0
  visibility.mjs     DataForSEO: 8 buyer questions in ChatGPT, Gemini, Google AI Mode; 10 Google
                     searches with AI Overviews; AI Overview citation counts. Budget-capped.
  ai-prompts.json    the questions, searches and brand list visibility.mjs uses
  baseline/          dated output from 11 Oct 2026, the "before" for the monthly re-check
```

## Deploy to Cloudflare Pages

No build step.

**Git integration (recommended):** Cloudflare dashboard → Workers & Pages → Create → Pages →
Connect to Git → pick this repo. Framework preset: *None*. Build command: *(empty)*.
Build output directory: `site`. Every push to `main` redeploys.

**Direct upload, no Git:**

```bash
npx wrangler pages deploy site --project-name vitaco-search-health
```

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
DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... node scan/visibility.mjs --confirm --budget 0.5
node scan/visibility.mjs --confirm --only mentions   # one part only; writes its own file
```

Credentials come from environment variables only. Never commit them.

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
