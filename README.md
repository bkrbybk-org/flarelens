# Flarelens

Ops dashboard for Cloudflare: a single pane of glass for reviewing an account's **Zero Trust Access policies**, **WAF activity**, and **Cache Rules** — served entirely from one Cloudflare Worker.

## Sections

| Route | Section | Scope | What it shows |
|---|---|---|---|
| `#/access` | Access Applications | account | Apps, policies with human-readable include/require/exclude rules, IdPs, groups |
| `#/waf` | WAF Analytics | account or zone | `firewallEventsAdaptive` telemetry correlated against ruleset metadata: KPIs, events-over-time, per-ruleset/rule tables, action-drift detection |
| `#/cache` | Cache Rules | zone | Cache rules with last-match traffic attribution, hit-ratio health grade, insights, URL tester (client-side wirefilter evaluation) |

## Architecture

```
src/index.ts              Hono worker: API proxy + static asset serving
src/lib/waf-meta.ts       Ruleset metadata flattening (managed/custom, entrypoints)
src/lib/cache-analysis.ts GraphQL analytics, last-match attribution, insights, grade
web/                      Vite + React 19 + Tailwind 4 + TanStack Table SPA
web/src/lib/expr.ts       Wirefilter expression evaluator (single source; the
                          worker imports it for attribution, the client for the URL tester)
```

The worker never stores credentials: the browser holds the API token in `sessionStorage` and sends it per request as `Authorization: Bearer`; the worker forwards it to `api.cloudflare.com` within the same invocation. Strict CSP (`'self'` only, no inline), security headers on every response (`run_worker_first`), `Cache-Control: no-store` on all `/api/*`.

## API token scopes

Account Settings: Read · Access: Read (apps, policies, groups, IdPs) · Zone: Read · Cache Rules: Read · Analytics: Read · Zone WAF: Read · Account WAF: Read.

Sections degrade individually when a scope is missing (per-section error banner, not app-wide failure).

## Development

Requires **Node ≥ 20.19** (Vite 8). With nvm: `nvm use 24`.

```sh
npm install
npm run dev:worker   # wrangler dev on :8787 (API + built assets)
npm run dev          # vite on :5173, proxies /api → :8787 (frontend iteration)
```

For a production-like run: `npm run build && npm run dev:worker` and open :8787.

## Scripts

| Script | Purpose |
|---|---|
| `npm test` | Vitest unit suite (expression evaluator, WAF aggregation, cache attribution/insights, rule descriptions) |
| `npm run check` | tsc project build + tests + vite build + wrangler dry-run |
| `npm run lint` | ESLint |
| `npm run build` | Vite production build → `web/dist` |
| `npm run deploy` | Build then `wrangler deploy` |

## Data-honesty notes (Cache section)

Inherited from the original cf-cache-analyzer: hit ratio counts `hit + stale + updating + revalidated` as served (Cloudflare-consistent); traffic matching no path-evaluable rule is shown as an explicit *unattributed* block, never redistributed; analytics failures fall back to clearly-labeled simulated data; a genuinely quiet zone shows zeros, not mocks.
