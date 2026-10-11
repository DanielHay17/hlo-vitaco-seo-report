# Vitaco search health report (Phlo)

Client-facing report for Dhiren Dunraj, Vitaco Health. Meeting: Wed 14 Oct 2026, 11am.

```
site/        static report, deployed to Cloudflare Pages (the only public directory)
scan/        the "Find" and "Re-check" steps of the loop
  health-check.mjs   plain HTTP checks across all six sites, $0 per run
  serp-check.mjs     DataForSEO page-one check, budget-capped, dry run by default
  keywords.txt       queries for serp-check (no search operators)
  baseline/          dated scan output, the "before" for the day-30 re-check
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
node scan/serp-check.mjs                      # dry run: plan + estimated cost, spends nothing
DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... node scan/serp-check.mjs --confirm --budget 0.50
```

Guardrails, because the official MCP server (`dataforseo/mcp-server-typescript`, default branch
`master`) exposes a generic `api_request` tool that will hit any endpoint with no allowlist:

- One hard-coded endpoint: `serp/google/organic/live/advanced`, Australia, depth 10.
- Refuses keywords containing search operators (`site:`, `inurl:`, quotes, `-term`, `OR`), since
  each operator bills as an extra SERP.
- Aborts if the estimate exceeds `--budget`, and stops mid-run using the API's reported `cost`.
- Check `EST_COST_PER_SERP` in the script against your dashboard before the first paid run.

If you also use the MCP server interactively in Claude Code, require approval for the passthrough:
add `"mcp__dataforseo__api_request"` to `permissions.ask` in `.claude/settings.json`.
