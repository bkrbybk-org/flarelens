# Flarelens

Ops dashboard for Cloudflare: a single pane of glass for reviewing an account's **Zero Trust Access policies**, **WAF activity**, and **Cache Rules** — served entirely from one Cloudflare Worker.

## Sections

| Route | Section | Scope | What it shows |
|---|---|---|---|
| `#/access` | Access Applications | account | Apps and their policies, with include/require/exclude rules rendered as readable sentences; filterable/sortable table, per-app detail drawer |
| `#/groups` | Access Groups | account | Reusable Access Groups with their rules, cross-referenced to the applications whose policies use them |
| `#/waf` | WAF Analytics | account or zone | `firewallEventsAdaptive` telemetry correlated against ruleset metadata: KPIs, events-over-time, per-ruleset/rule tables, action-drift detection, per-rule drill-down |
| `#/cache` | Cache Rules | zone | Cache rules with last-match traffic attribution, hit-ratio health grade, insights, URL tester (client-side wirefilter evaluation) |
| `#/access-usage` | Access Usage | account | Access login telemetry from `accessLoginRequestsAdaptiveGroups`: login volume with a success/failure split, and top applications, identity providers and countries. Aggregate only — per-user identity dimensions are deliberately not queried. Cloudflare caps this dataset at a 1-week window |
| `#/workers` | Workers Analytics | account | Per-script invocation telemetry from `workersInvocationsAdaptive`: requests, errors, subrequests and CPU P50, as summary cards, a line/bar chart by worker, and a per-worker table with error rates |
| `#/workers-ai` | Workers AI | account | Inference analytics from `aiInferenceAdaptiveGroups`: requests, neurons, input/output tokens, average latency and errors, charted over time with a per-model table plus request-source and error-code breakdowns |
| `#/findings` | Findings | account (+ loaded sections) | Severity-ranked audit view: publicly-reachable apps, apps with no policy, `bypass` decisions, unreferenced groups, WAF action drift, cache insights and health grade |

Sections carry deep-linkable state, e.g. `#/waf?zone=<id>&lookback=1440&tab=rules` or `#/cache?zone=<id>&range=168`.

Findings always covers Access and Groups. WAF and Cache are zone-scoped and fetched by their own pages, so their findings fold in only once you have opened those sections — the page says so explicitly per source rather than implying a clean bill of health it has not checked.

**Export:** the Access table and the Findings page export CSV (respecting the active filters and visible columns), and Findings has a print stylesheet for Save-as-PDF.

## Architecture

```
src/index.ts              Hono worker: API proxy + static asset serving
src/lib/waf-meta.ts       Ruleset metadata flattening (managed/custom, entrypoints)
src/lib/cache-analysis.ts GraphQL analytics, last-match attribution, insights, grade
web/                      Vite + React 19 + Tailwind 4 + TanStack Table SPA
web/src/lib/expr.ts       Wirefilter expression evaluator (single source; the
                          worker imports it for attribution, the client for the URL tester)
```

By default the worker holds no credentials: the browser keeps the API token in `sessionStorage` and sends it per request as `Authorization: Bearer`; the worker forwards it to `api.cloudflare.com` within the same invocation. A deployment may instead bind a token and authenticate operators with Cloudflare Access — see [Deployment modes](#deployment-modes). Strict CSP (`'self'` only, no inline), security headers on every response (`run_worker_first`), `Cache-Control: no-store` on all `/api/*`.

See [PROGRESS.md](PROGRESS.md) for the full route table, hook inventory, storage keys, open issues, and roadmap.

## API token scopes

**Required** — the connect screen checks these two live and reports which one failed:

| Scope | Unlocks |
|---|---|
| Account Settings: Read | Account discovery and the account switcher |
| Access: Read | Applications, policies, identity providers |

**Optional** — each only narrows one section, which then shows its own error banner rather than failing the app:

| Scope | Unlocks |
|---|---|
| Access: Organizations, Identity Providers, and Groups | Group names inside policy rules; the Access Groups section |
| Zone: Read | Zone picker for WAF Analytics and Cache Rules |
| Account WAF: Read · Zone WAF: Read | Ruleset metadata in WAF Analytics |
| Cache Rules: Read | Cache Rules section |
| Zone Analytics: Read | Traffic and hit-ratio data in Cache Rules |

## Deployment modes

The worker resolves credentials once, in [src/lib/auth.ts](src/lib/auth.ts). Two modes:

| Mode | Trigger | Token used | Audit trail |
|---|---|---|---|
| **BYOT** (default) | request carries `Authorization: Bearer <token>` | the caller's own | Cloudflare attributes each read to the operator's token |
| **Server** | no Bearer header, and the deployment is fully configured (below) | the bound `CF_API_TOKEN` | every read shows as one token |

A Bearer header always wins, so server mode can never silently substitute the bound token for a
caller's own. With none of the configuration below set, the worker behaves exactly as it always
has: no token, no data.

### Enabling server mode

Server mode is **off unless all three** are configured, and it will not turn itself on partially:

```bash
wrangler secret put CF_API_TOKEN
```

```jsonc
// wrangler.jsonc — vars, not secrets
"vars": {
  "CF_ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
  "CF_ACCESS_AUD": "<Access application AUD tag>",
  "ALLOWED_ACCOUNT_IDS": "<account id>[,<account id>]",
  "ALLOWED_ZONE_IDS": "<zone id>[,<zone id>]"
}
```

`CF_API_TOKEN` goes in a **secret**, never in `vars` — `vars` is plaintext in this file and in the
dashboard. Give it the read-only scopes in the table above and nothing more.

**Cloudflare Access is not optional here.** The app has no login of its own: in BYOT mode the
Cloudflare token *is* the authentication, and binding a token removes that. Without the Access
gate, anyone who resolves the hostname reads the bound account. The worker therefore verifies the
`Cf-Access-Jwt-Assertion` JWT (signature, issuer, audience, expiry) against the team's JWKS before
using the secret, and ignores `Cf-Access-Authenticated-User-Email`, which is a plain forgeable
header. Put an Access application in front of the route and scope its policy to the right group.

`ALLOWED_ACCOUNT_IDS` / `ALLOWED_ZONE_IDS` bound what server mode can reach. Account and zone ids
still arrive from the client on every request; in BYOT mode Cloudflare bounds them to the caller's
own token, and in server mode there is no such per-user boundary, so the allowlist supplies it. An
empty account allowlist means server mode reaches nothing.

### Trade-offs to accept before enabling it

- **Shared rate limit.** Every user's queries count against one token's Cloudflare API budget.
  `/api/cache/analyze`, `/api/waf/events` and `/api/ai-security/analyze` are multi-page fan-outs.
- **Collapsed attribution.** Cloudflare's audit log names the bound token, not the person. Your own
  Access logs are then the only record of who read what.

### AI Security and the shared credential

`/api/ai-security/analyze` opts out of server mode by default and requires a Bearer token even
where server mode is enabled: its rows carry client IPs and encrypted request payloads, and
reading them under a shared credential is exactly where collapsed attribution hurts most. Set
`AI_REQUIRES_BYOT: "0"` in `vars` to let that section run under the bound token like the others.

## Development

Requires **Node ≥ 22** — Wrangler 4 enforces this, and it is stricter than Vite 8's own `≥ 20.19`. With nvm: `nvm use 24`.

```sh
npm install
npm run dev:worker   # wrangler dev on :8787 (API + built assets)
npm run dev          # vite on :5173, proxies /api → :8787 (frontend iteration)
```

For a production-like run: `npm run build && npm run dev:worker` and open :8787.

## Tests

`npm test` runs everything except the live E2E suite, which is opt-in. No test touches the
network unless you ask it to.

| Layer | Files | What it covers |
|---|---|---|
| Unit | `tests/{expr,rules,csv,findings,cache-analysis,waf-*,auth}.test.ts`, `tests/ai-sec-*.test.ts` | Pure logic: wirefilter evaluation, rule rendering, findings, CSV, WAF aggregation, Access JWT verification, and the AI Security domain layer (windows, bucketing, detection predicates, catalogs, mitigation ranking) |
| Integration | `tests/integration-ai-security.test.ts` | The AI route wired to the ported library, Cloudflare client and Cache API, with only the network mocked — including cache-key tenant isolation |
| System | `tests/system-routes.test.ts` | Every route through the real app against one mocked Cloudflare, plus the cross-cutting header and `no-store` contract |
| Compatibility | `tests/compat-upstream-shapes.test.ts` | Upstream drift the app does not control: pagination, partial-scope tokens, unknown detection categories, non-JSON responses, and the Workers globals Node lacks |
| Security | `tests/security-boundaries.test.ts`, `tests/routes-auth.test.ts`, `tests/no-adhoc-auth.test.ts` | The adversarial half: credential confinement, allowlist evasion, input handling, and the guardrail that keeps credential resolution in one module |
| E2E | `tests/e2e-live.test.ts` | The deployed Worker through real Cloudflare Access with the bound token. **Opt-in** |

The E2E suite needs an Access service token that the app's Access policy admits, read from the
gitignored `.dev.vars` (or `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` in the environment):

```bash
FLARELENS_E2E=1 npx vitest run tests/e2e-live.test.ts
```

It hits production by default; point it elsewhere with `FLARELENS_E2E_URL`. It spends real
Cloudflare API quota, which is why it never runs as part of `npm test`.

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
