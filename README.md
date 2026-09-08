# Flarelens

Ops dashboard for Cloudflare: a single pane of glass for reviewing an account's **Zero Trust Access policies**, **WAF activity**, and **Cache Rules** — served entirely from one Cloudflare Worker.

## Sections

| Route | Section | Scope | What it shows |
|---|---|---|---|
| `#/access` | Access Applications | account | Apps and their policies, with include/require/exclude rules rendered as readable sentences; filterable/sortable table, per-app detail drawer |
| `#/groups` | Access Groups | account | Reusable Access Groups with their rules, cross-referenced to the applications whose policies use them |
| `#/access-usage` | Access Usage | account | Access login telemetry from `accessLoginRequestsAdaptiveGroups`: volume with a success/failure split, and top applications, identity providers and countries. Cloudflare caps this dataset at a 1-week window |
| `#/request` | Request Trace | account or zone | Everything Cloudflare records about one HTTP request, found by Ray ID: WAF attack scores, bot score and decision, JA3/JA4 fingerprints, TLS, device type, method, path, query, referer, content scanning, edge and origin timings, every firewall rule that matched, and — where a payload-logging rule captured it — the request body, decrypted in the browser. Fields beyond the curated groups are swept from the schema, so detail Cloudflare adds later appears without a code change. Field selection follows a live schema probe, and absence is reported as inconclusive because `httpRequestsAdaptive` is adaptively sampled |
| `#/tunnels` | Tunnel Map | account | The chain behind a self-hosted app: public hostname → Access application and its policy decisions → Cloudflare Tunnel → origin service. Flags both gaps — a tunnel ingress with no Access app in front of it, and an Access app whose hostname no tunnel serves |
| `#/gateway` | Gateway Usage | account | Zero Trust Gateway: DNS resolver queries and Gateway HTTP requests over time, split allowed/blocked, with top categories, policies, hosts and actions |
| `#/pqc` | PQC Readiness | account | Post-quantum coverage per hostname: every A/AAAA/CNAME record in the account's zones, split by the two TLS legs — visitor→Cloudflare (proxied and TLS 1.3 on, so X25519MLKEM768 is offered) and Cloudflare→origin (tunnel, Cloudflare-hosted, automatic key exchange, or plain HTTP). Ranked worst first, with per-zone TLS settings and CSV export |
| `#/waf` | WAF Analytics | account or zone | `firewallEventsAdaptive` telemetry correlated against ruleset metadata: KPIs, events-over-time, per-ruleset/rule tables, action-drift detection, per-rule drill-down |
| `#/ai-security` | AI Security for Apps | account or zone | Prompt-injection, PII, unsafe-topic and custom-topic detections on LLM traffic: KPIs, detections over time, endpoint/country/session breakdowns, ranked mitigations, and a flagged-request table with per-row prompt decryption |
| `#/cache` | Cache Rules | zone | Cache rules with last-match traffic attribution, hit-ratio health grade, insights, URL tester (client-side wirefilter evaluation) |
| `#/workers` | Workers Analytics | account | Per-script invocation telemetry from `workersInvocationsAdaptive`: requests, errors, subrequests and CPU P50, as summary cards, a line/bar chart by worker, and a per-worker table with error rates |
| `#/workers-ai` | Workers AI | account | Inference analytics from `aiInferenceAdaptiveGroups`: requests, neurons, input/output tokens, average latency and errors, with a per-model table plus request-source and error-code breakdowns |
| `#/cost` | Cost & Usage | account | Billable units across Workers and Workers AI for the window, priced with rates you enter. No Cloudflare list prices ship with the app |
| `#/findings` | Findings | account (+ loaded sections) | Severity-ranked audit view: publicly-reachable apps, apps with no policy, `bypass` decisions, unreferenced groups, WAF action drift, cache insights and health grade |

Sections carry deep-linkable state, e.g. `#/waf?zone=<id>&lookback=1440&tab=rules` or `#/cache?zone=<id>&range=168`.

Findings always covers Access and Groups. WAF and Cache are zone-scoped and fetched by their own pages, so their findings fold in only once you have opened those sections — the page says so explicitly per source rather than implying a clean bill of health it has not checked.

**Export:** the Access table and the Findings page export CSV (respecting the active filters and visible columns), and Findings has a print stylesheet for Save-as-PDF.

## Architecture

```
src/index.ts                 Hono worker: every /api route, security headers, asset serving
src/lib/auth.ts              Credential resolution: Access JWT verification, account/zone allowlist
src/lib/waf-meta.ts          Ruleset metadata flattening (managed/custom, entrypoints)
src/lib/cache-analysis.ts    GraphQL analytics, last-match attribution, insights, grade
src/lib/access-usage.ts      Access login telemetry
src/lib/gateway-usage.ts     Zero Trust Gateway DNS + HTTP telemetry
src/lib/workers-analytics.ts Workers invocation metrics
src/lib/workers-ai.ts        Workers AI inference metrics
src/lib/ai-sec/              AI Security: zone fan-out, schema probing, domain aggregation
web/                         Vite + React 19 + Tailwind 4 + TanStack Table SPA
web/src/hooks/useTimeRange.ts   Shared analytics window, clamped per section
web/src/components/chart/       Inline-SVG hover readout used by every chart
web/src/features/ai-security/matchedData.ts
                             HPKE decryption of logged prompts, browser-side only
web/src/lib/expr.ts          Wirefilter expression evaluator (single source; the
                             worker imports it for attribution, the client for the URL tester)
```

All time-windowed sections share one range picker in the top bar, stored in minutes and clamped
per section to what its upstream dataset allows — Access Usage to 7 days, Cache to 24h/7d/30d,
WAF to the worker's own bounds. The range is deep-linkable as `#/<route>?range=<preset>`.

Charts are inline SVG rather than a charting library: the CSP allows scripts from `'self'` only,
so a CDN-loaded chart library could not run here.

### Layout invariants

The shell is a fixed-height flex column: the sidebar and top bar stay put, and each section
scrolls inside `<main>`. Three classes on `<main>` hold that together, and all three are pinned by
[tests/shell-layout.test.ts](tests/shell-layout.test.ts) because none of them fail loudly:

| Class | Why |
|---|---|
| `min-h-0` | A flex item defaults to `min-height: auto`, so without it the column grows to fit its content instead of the viewport, and no section can become a scroll container |
| `overflow-hidden` | Nothing may spill past the region that owns the scrolling |
| `relative` | **`overflow` does not create a containing block.** Without it, every `sr-only` label and every icon absolutely positioned inside an input anchors to the initial containing block rather than the scroller. Deep in a long page those sit past the fold — one landed at 1444px against a 900px viewport — stretching `<html>` until the *document* scrolls, which drags the sidebar and top bar out of view |

Each section root carries its own `h-full overflow-auto`. A section that loses it is clipped by
`<main>` with no way to reach the rest of its content.

Credentials resolve at one choke point, [src/lib/auth.ts](src/lib/auth.ts). In BYOT mode the
browser keeps the API token in `sessionStorage` and sends it per request as `Authorization:
Bearer`, and the worker forwards it to `api.cloudflare.com` within the same invocation, holding
nothing. In server mode the worker uses its own bound `CF_API_TOKEN`, but only behind Cloudflare
Access and only for allowlisted accounts — see [Deployment modes](#deployment-modes). **This
deployment runs in server mode.** Strict CSP (`'self'` only, no inline), security headers on every response (`run_worker_first`), `Cache-Control: no-store` on all `/api/*`.

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
| Zone: Read | Zone picker for WAF Analytics, Cache Rules and AI Security |
| Account WAF: Read · Zone WAF: Read | Ruleset metadata in WAF Analytics |
| Cache Rules: Read | Cache Rules section |
| Zone Analytics: Read | Traffic and hit-ratio data in Cache Rules, and the request/detection telemetry behind AI Security |
| Analytics: Read | Prompt injection, PII and topic detections in AI Security; Access Usage, Gateway Usage, Workers Analytics, Workers AI and Cost & Usage all read account-scoped GraphQL datasets behind this |
| Cloudflare Tunnel: Read | Tunnel names, status and ingress rules in the Tunnel Map, and the private network routes. **Cloudflare returns an empty list rather than a 403 when this is missing**, so without it the page cannot tell an account with no tunnels from a token that cannot see them — it says so rather than showing a blank map |
| Zone: DNS: Read | The hostname inventory behind PQC Readiness. Without it each zone is still listed, carrying its own error and no hostnames, rather than the page reporting a clean but empty account |
| Zone Settings: Read | TLS 1.3, minimum TLS version and SSL mode, which every PQC verdict depends on. Cloudflare answers a token without it with `Unauthorized to access requested resource`, and the page reports each zone's settings as unreadable rather than assuming a default |
| Workers Scripts: Read | Adds workers with no traffic in the window to the Workers Analytics filter, and lets the Tunnel Map identify an Access application served by a Worker on a custom domain instead of reporting it as having no route. Both degrade rather than fail without it |

### Reading logged prompts

Enabling AI Security, labelling endpoints `cf-llm`, Log Mode vs Production Mode, and where the
payload-logging key pair comes from are covered in
[docs/ai-security-setup.md](docs/ai-security-setup.md).


AI Security can show the prompt behind a flagged request, which is usually what decides whether a
detection is a false positive. That is **not** an API token scope: Cloudflare encrypts logged
payloads to a public key you generate when enabling payload logging, and the matching private key
decrypts them.

Paste that key into the Events tab. It is used in the browser only — never sent to the Worker,
which only ever handles ciphertext, and never written to storage, so it has to be entered again
each session. Decryption is per row and on demand, because reading a prompt means reading whatever
the user typed, including the PII that flagged it.

The format is Cloudflare's "matched data" blob: HPKE base mode over DHKEM(X25519, HKDF-SHA256)
with AES-256-GCM, framed as `version || enc(32) || plaintext length (uint64 LE) || ciphertext`.
It is not published anywhere we control, so it was derived from live payloads and is pinned by a
round-trip test in [tests/matched-data.test.ts](tests/matched-data.test.ts).

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
  "ALLOWED_ZONE_IDS": "<zone id>[,<zone id>]",
  "AI_REQUIRES_BYOT": "0"
}
```

```jsonc
// wrangler.jsonc — reports the running version and deploy time in the sidebar footer
"version_metadata": { "binding": "CF_VERSION_METADATA" }
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

`/api/ai-security/analyze` can opt out of server mode and require a Bearer token even where
server mode is enabled: its rows carry client IPs and encrypted request payloads, and reading them
under a shared credential is where collapsed attribution hurts most. Set `AI_REQUIRES_BYOT` to
`"1"` (or remove it) for that behaviour.

**This deployment sets `"0"`**, so AI Security runs under the bound token like every other
section. That is deliberate: the UI carries no token in server mode, so requiring one would make
the section unreachable, and the sensitive part — the prompt itself — is gated on holding the
zone's payload-logging private key rather than on the API token. The Worker only ever handles
ciphertext.

### What AI Security caches at the edge

AI Security is the one section that caches upstream data, because a page load fans out a GraphQL
query per zone. The zone query is **split in two** so that caching costs nothing in exposure:

| Half | Contents | Cached |
|---|---|---|
| Aggregates | Request and detection counts, previous-period counts, bucketed series | Yes — `caches.default`, 60s, keyed by a SHA-256 fingerprint of the calling token so one operator's telemetry can never be served to another |
| Rows | One entry per flagged request: client IP, JA4, host, path, ray ID, and the encrypted prompt | **No.** Re-fetched on every load and discarded with the response |

So what sits at the edge for the TTL is counts and timestamps. Nothing that identifies a
requester, and no payload ciphertext, is written there. The cost is a second round trip per zone
on a cold cache; on a warm one only the row query runs.

Bump `RESULT_VERSION` in [queries.ts](src/lib/ai-sec/cf/queries.ts) whenever the cached shape
changes — it is part of the cache key, so a deploy that changes the shape misses rather than
reading back stale-shaped JSON.

## Cloudflare API constraints worth knowing

Behaviour of the upstream API that is not obvious, cost real debugging time, and is not
documented anywhere we control. Each is handled in code; this is why the handling exists.

**An empty list can mean "not permitted".** `/accounts/{id}/cfd_tunnel` answers a token without
**Cloudflare Tunnel: Read** with `200 success:true total_count:0`, not `403`. An empty tunnel map
is therefore ambiguous, and the Tunnel Map says so rather than rendering a blank table that reads
as a clean bill of health.

**A zone query may select at most 70 fields.** Exceeding it fails the whole query with
`number of fields can't be more than 70`. Request Trace budgets its schema sweep against that
ceiling, and parses the number out of the error to trim if the ceiling ever changes.

**A field can exist in the schema and still be refused for a zone.** Fraud detection fields
(`fraudAttack`, `fraudUserId`, `fraudEmailRisk`, `fraudEventType`) introspect fine and then fail
with `zone '…' does not have access to the field 'fraudattack'`, rejecting the entire query.
Cloudflare names the offender, so Request Trace drops it and retries rather than losing every
swept field to one of them.

**The `origin_post_quantum_encryption` zone API is a no-op.** Cloudflare documents requests to
it as having no effect on key agreement behaviour, and plans to deprecate it. What replaced it is
[automatic key exchange](https://developers.cloudflare.com/ssl/origin-configuration/automatic-key-exchange/):
Cloudflare scans active origins roughly every 24 hours and prefers `X25519MLKEM768` when the origin
supports it. **That scan result is not exposed per zone**, which is why PQC Readiness reports the
origin leg of a Full-mode zone as *eligible* rather than compliant — the only honest verdict the
API supports. To settle a specific origin:

```bash
bssl client -connect <origin>:443 -curves X25519MLKEM768
```

Measured adoption is a separate matter: the `ClientTLSKeyExchangeGroup` field (values
`X25519MLKEM768`, `X25519`, `P-256`, `UNK`, `NONE`) exists in the `http_requests` **Logpush**
dataset and Log Explorer, not in the GraphQL Analytics schema this app reads. If it appears in
`httpRequestsAdaptiveGroups`, PQC Readiness can gain a measured column; until then it reports
configuration, not observed traffic.

**Gateway reports an outcome as free text, not a boolean.** Gateway HTTP rows carry the policy
`action` (`allow`, `block`, `quarantine`, `isolate`, `off`, …) and DNS rows carry a camelCase
`resolverDecision` (`blockedOnBlockPolicy`, `allowedOnNoPolicyMatch`, `overrideForSafeSearch`, …).
Gateway Usage counts anything naming a block or a quarantine as blocked and everything else as
allowed, so a verdict Cloudflare adds later is never silently counted as a block. `isolate` is
deliberately not a block — the request is served, through Browser Isolation — and the Override,
Safe Search and YouTube Restricted Mode actions rewrite the answer rather than refusing it, so
"allowed" here means "not blocked", not "unmodified".

**Recreating the Access application changes its AUD**, and server mode stops working the moment
it does: every gated route 401s and the SPA falls back to asking for a token. That happened on
2026-09-07. The live value is readable from the login redirect on the protected hostname:

```bash
curl -sS -o /dev/null -w "%{redirect_url}\n" https://<host>/health
```

The `kid` query parameter is the AUD, and the `meta` JWT's payload carries it too. Update
`CF_ACCESS_AUD` in [wrangler.jsonc](wrangler.jsonc) and redeploy.

Pinning the AUD in config rather than resolving it at runtime is deliberate: a swapped Access
application should stop the app, not be trusted silently.

## Tests

`npm test` runs everything except the live E2E suite, which is opt-in. No test touches the
network unless you ask it to.

| Layer | Files | What it covers |
|---|---|---|
| Unit | `tests/{expr,rules,csv,findings,cache-analysis,waf-meta,waf-aggregate,waf-chart,hash-params,auth,chart-hover}.test.ts`, `tests/ai-sec-*.test.ts` | Pure logic: wirefilter evaluation, rule rendering, findings, CSV, WAF aggregation and bucketing, hash deep-link helpers, Access JWT verification, chart hover placement, and the AI Security domain layer including `buildDashboard` |
| Integration | `tests/integration-ai-security.test.ts` | The AI route wired to the ported library, Cloudflare client and Cache API, with only the network mocked — including cache-key tenant isolation |
| System | `tests/system-routes.test.ts`, `tests/{access-usage,gateway-usage,workers-analytics,workers-ai}.test.ts` | Every route through the real app against one mocked Cloudflare: response shapes, validation, upstream error mapping, and the cross-cutting header and `no-store` contract |
| Compatibility | `tests/compat-upstream-shapes.test.ts` | Upstream drift the app does not control: pagination, partial-scope tokens, unknown detection categories, non-JSON responses, and the Workers globals Node lacks |
| Security | `tests/security-boundaries.test.ts`, `tests/routes-auth.test.ts`, `tests/no-adhoc-auth.test.ts`, `tests/matched-data.test.ts` | The adversarial half: credential confinement, allowlist evasion, input handling, the guardrail keeping credential resolution in one module, and the prompt-decryption boundaries — key never stored, never sent, never exported |
| Regression | `tests/shell-layout.test.ts`, `tests/apps-export.test.ts`, `tests/error-boundary.test.ts` | Failures with no runtime error to catch them: the flex height chain that decides whether sections or the shell scroll, CSV exporting rendered text rather than raw JSON, and the error-boundary message formatter |
| E2E | `tests/e2e-live.test.ts` | The deployed Worker through real Cloudflare Access with the bound token. **Opt-in** |

Some suites assert against source text rather than behaviour — that a page has its own scroll
container, that no module outside `src/lib/auth.ts` reads the `Authorization` header, that the
decryption key never reaches storage. Those properties have no observable failure mode in a Node
test environment, and reviewing for them by eye has already proved unreliable.

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
| `npm test` | Vitest suite — unit, integration, system, compatibility, security and regression layers (see [Tests](#tests)). Excludes the opt-in live E2E suite |
| `npm run check` | tsc project build + tests + vite build + wrangler dry-run |
| `npm run lint` | ESLint |
| `npm run build` | Vite production build → `web/dist` |
| `npm run deploy` | Build then `wrangler deploy` |

## Debugging the UI against real data

The app is behind Cloudflare Access, so a browser cannot reach the deployed API without an
interactive login, and the local Worker has no credentials. To drive the real SPA against real
account data, point the dev server's proxy at the deployment and authenticate with the Access
service token from `.dev.vars`:

```ts
// vite.config.ts — temporary, revert when finished
server: {
  proxy: {
    "/api": {
      target: "https://flarelens.example.com",
      changeOrigin: true,
      headers: {
        "CF-Access-Client-Id": devVar("CF_ACCESS_CLIENT_ID"),
        "CF-Access-Client-Secret": devVar("CF_ACCESS_CLIENT_SECRET"),
      },
    },
  },
}
```

Seed a session so the shell renders rather than the connect screen, then measure:

```js
sessionStorage.setItem("cf_api_token", "probe");
sessionStorage.setItem("cf_account_id", "<account id>");
```

**Measure layout, do not reason about it.** Two consecutive fixes for the shell-scrolling bug were
shipped on plausible CSS reasoning and neither was the cause; reading `document.documentElement.scrollHeight`
against `window.innerHeight` in the running app found it in one step. Useful probes:
`html.scrollHeight` vs `innerHeight`, each container's `scrollHeight > clientHeight`, and the
computed `position` of every absolutely positioned node.

Never commit the proxy: it sends a live credential from a config file that is not gitignored.

## Data-honesty notes (Cache section)

Inherited from the original cf-cache-analyzer: hit ratio counts `hit + stale + updating + revalidated` as served (Cloudflare-consistent); traffic matching no path-evaluable rule is shown as an explicit *unattributed* block, never redistributed; analytics failures fall back to clearly-labeled simulated data; a genuinely quiet zone shows zeros, not mocks.
