# Flarelens

Ops dashboard for Cloudflare: one pane of glass for reviewing an account's **Zero Trust** configuration and telemetry, **security** posture (WAF, AI Security, PQC readiness, request forensics), **cache rules**, and **developer-platform usage** — nineteen sections served entirely from one Cloudflare Worker.

## Sections

| Route | Section | Scope | What it shows |
|---|---|---|---|
| `#/access` | Access Applications | account | Apps and their policies, with include/require/exclude rules rendered as readable sentences; filterable/sortable table, per-app detail drawer, and a **Logins (7d)** column showing how many times each application was actually signed into. Unknown and zero are distinct: a dash means the telemetry could not be read and says why, an amber 0 means nobody signed in this week |
| `#/groups` | Access Groups | account | Two tabs over the account-level configuration applications attach by reference. **Reusable policies** (default) is a sortable, filterable table — decision, rule counts, attached applications, created/updated — sorted by last update, with Excel-style column filters, a column selector with drag-to-reorder (Created hidden by default), search, CSV export and an expandable row showing the policy's rules; a policy attached to nothing is flagged, since it enforces nothing. A rule referencing a Zero Trust list resolves to the list's name and size, with its entries expandable inline. **Rule groups** lists Access Groups with their rules, cross-referenced to the applications whose policies use them. Deep-linkable as `#/groups?tab=groups` |
| `#/access-usage` | Access Usage | account | Access login telemetry from `accessLoginRequestsAdaptiveGroups`: volume with a success/failure split, and top applications, identity providers and countries. Cloudflare caps this dataset at a 1-week window |
| `#/request` | Request Trace | account or zone | Everything Cloudflare records about one HTTP request, found by Ray ID: WAF attack scores, bot score and decision, JA3/JA4 fingerprints, TLS, device type, method, path, query, referer, content scanning, edge and origin timings, every firewall rule that matched, and — where a payload-logging rule captured it — the request body, decrypted in the browser. Fields beyond the curated groups are swept from the schema, so detail Cloudflare adds later appears without a code change. Field selection follows a live schema probe, and absence is reported as inconclusive because `httpRequestsAdaptive` is adaptively sampled |
| `#/tunnels` | Tunnel Map | account | The chain behind a self-hosted app: public hostname → Access application and its policy decisions → Cloudflare Tunnel → origin service. Opens with a flow diagram — Access → tunnel → origin, one ribbon row per destination — so the proportion of the estate that is gated, exposed or unidentified reads before any row does; clicking a tunnel filters the table. Flags both gaps — a tunnel ingress with no Access app in front of it, and an Access app whose hostname no tunnel serves. Clicking a tunnel in the Tunnels list opens its details: status, config source, connected-since, and every `cloudflared` connector — version, architecture, start time, features, and each edge connection's data center, open time, source IP and reconnect state — plus the hostnames and private routes it serves. Health notes flag a single connector (no redundancy), connectors on different versions, and connectors holding fewer than four connections or reconnecting. CPU and memory are not shown: Cloudflare's API does not report them, and `cloudflared` exposes them only on its local metrics endpoint |
| `#/gateway` | Gateway Usage | account | Zero Trust Gateway: DNS resolver queries and Gateway HTTP requests over time, split allowed/blocked, with top categories, policies, hosts and actions |
| `#/gateway-policies` | Gateway Policies | account | The account's Gateway *rules* (not telemetry), laid out the way Cloudflare's documented [order of enforcement](https://developers.cloudflare.com/cloudflare-one/policies/gateway/order-of-enforcement/) actually runs them: DNS resolver, then DNS, then Network (L4), then HTTP, ascending precedence within each. DNS's own pre- vs post-resolution selector ordering is not modeled — the view says so rather than guessing. **Findings:** disabled rules, a rule sitting behind an earlier enabled terminating rule of the same type whose traffic/identity/device-posture are all empty or literally `true` (only this narrow case is claimed, as in WAF's evaluation order), an HTTP `allow` rule with no identity condition, `off` (Do Not Inspect) rules, and `rule_settings.untrusted_cert` set to `pass_through`. Type filter and search deep-link via `#/gateway-policies?gp_type=http&q=…`; CSV export. See [src/lib/gateway-policies.ts](src/lib/gateway-policies.ts) |
| `#/pqc` | PQC Readiness | account | Post-quantum coverage per hostname: every A/AAAA/CNAME record in the account's zones, split by the two TLS legs — visitor→Cloudflare (proxied and TLS 1.3 on, so X25519MLKEM768 is offered) and Cloudflare→origin (tunnel, Cloudflare-hosted, automatic key exchange, or plain HTTP). Ranked worst first, with per-zone TLS settings and CSV export. The zone table also grades each zone's allowed TLS 1.0–1.2 cipher suites — forward secrecy and AEAD judged separately, obsolete families called out. A separate "TLS posture" section grades zone hygiene (minimum TLS version, Full vs Full-strict, HSTS, Always Use HTTPS) — real gaps, but never a verdict input. Underscore-prefixed validation records (ACME, DKIM) are excluded from the verdicts and counted, not dropped |
| `#/zone-health` | Zone Health | account | **Certificates:** expiry across the three sources Cloudflare exposes separately — managed edge packs (flagged under 7 days, since they should have renewed; a pack that never issued is flagged too), uploaded custom certificates (14/30 days) and Origin CA (30 days) — each reported as *not checked, with the missing permission* when Cloudflare refuses it. **DNS hygiene:** CNAMEs to tunnels that no longer exist, external CNAME targets that return NXDOMAIN (subdomain takeover), DNS-only records publishing an origin IP, and exact duplicates. Every check that could not run is listed as unknown with its reason, and the clean state states how many records were checked |
| `#/dns` | DNS Records | account | Every DNS record across the account's zones in one sortable, filterable table — zone, type, name, content, proxy status, TTL (Cloudflare's TTL=1 sentinel rendered as "Auto", never "1s"), flags and last modified. Flags a DNS-only A/AAAA record that could be proxied as an exposed origin. Search, type and zone filters (deep-linkable via `#/dns?type=CNAME`), CSV export, and a per-zone error list for any zone whose DNS read failed — reported with its reason, not dropped |
| `#/waf` | WAF Analytics | account or zone | `firewallEventsAdaptive` telemetry correlated against ruleset metadata: KPIs, events-over-time, per-ruleset/rule tables, action-drift detection, per-rule drill-down. **Rules Review** groups every rule under its ruleset — collapsible, busiest first, with rule, disabled and drift counts per ruleset, the zone named on zone custom rulesets (their entrypoints are all called `default`), and rules missing from the ruleset metadata collected last as *Unattributed*. An **Evaluation order** toggle lays the same rules out the way Cloudflare runs them: custom rules → rate limiting → managed rules, account entrypoint before each zone's, each list top-down, with `execute` rules expanding into the ruleset they run. It marks rules that never run — behind a disabled deployment, or behind an enabled terminating rule whose expression is literally `true` — per zone, and lists rulesets nothing deploys. Managed-rule overrides are not reflected, and overlap between narrower expressions is not analysed. A window wider than 7 days carries a warning: on this account a 30-day window returned fewer events than a 7-day one, so counts are not comparable across window sizes |
| `#/bots` | Rate Limits & Bots | account or zone | Configuration review, not telemetry. **Rate limiting:** every rule on the `http_ratelimit` phase entrypoint ruleset, per zone and account-wide — description, action, expression, characteristics, threshold ("N req / period"), mitigation timeout. A 404 on the entrypoint is a real, checked zero; a 403 is reported as not checked, naming the missing permission, and never rendered as zero. **Bot management:** per-zone settings (Bot Fight Mode / Super Bot Fight Mode / Enterprise Bot Management fields), with the plan tier inferred from which keys Cloudflare's response carries and unknown keys passed through untouched. **Findings:** a zone with no rate-limit rules, a disabled rule, a rule that only logs, bot protection entirely off, JS detection disabled, and AI bots not blocked — each severity-ranked, and never raised from a check that came back unknown |
| `#/ai-security` | AI Security | account or zone | Prompt-injection, PII, unsafe-topic and custom-topic detections on LLM traffic: KPIs, detections over time, endpoint/country/session breakdowns, ranked mitigations, and a flagged-request table with per-row prompt decryption |
| `#/cache` | Cache Rules | zone | Cache rules with last-match traffic attribution, hit-ratio health grade, insights, URL tester (client-side wirefilter evaluation) |
| `#/workers` | Workers Analytics | account | Per-script invocation telemetry from `workersInvocationsAdaptive`: requests, errors, subrequests and CPU P50, as summary cards, a line/bar chart by worker, and a per-worker table with error rates |
| `#/workers-ai` | Workers AI | account | Inference analytics from `aiInferenceAdaptiveGroups`: requests, neurons, input/output tokens, average latency and errors, with a per-model table plus request-source and error-code breakdowns |
| `#/ai-gateway` | AI Gateway | account | AI Gateway proxy traffic: requests over time, tokens, error rate, cache hit rate and spend, with per-gateway and per-model/provider breakdowns. Dataset, dimension and aggregate names are resolved from the live GraphQL schema at runtime rather than hardcoded, and the response names the candidates each was chosen from. Each supplementary dataset (errors, cache, spend) degrades to a stated "unavailable" panel independently, rather than failing the whole page. See [src/lib/ai-gateway.ts](src/lib/ai-gateway.ts) |
| `#/cost` | Cost & Usage | account | Billable units across Workers and Workers AI for the window, priced with rates you enter. No Cloudflare list prices ship with the app |
| `#/findings` | Findings | account (+ loaded sections) | Severity-ranked audit view: publicly-reachable apps, apps with no policy, `bypass` decisions, unreferenced groups, WAF action drift, cache insights and health grade. Access also flags sessions over 24h (medium from 7 days), session cookies without `HttpOnly`, CORS wildcards (medium with credentials), and allow policies admitted by email domain, login method or service token alone with no `require` |

Sections carry deep-linkable state, e.g. `#/waf?zone=<id>&lookback=1440&tab=rules` or `#/cache?zone=<id>&range=168`.

Findings always covers Access and Groups. WAF and Cache are zone-scoped and fetched by their own pages, so their findings fold in only once you have opened those sections — the page says so explicitly per source rather than implying a clean bill of health it has not checked.

**Export:** the Access table and the Findings page export CSV (respecting the active filters and visible columns; UTF-8 with a byte-order mark, and any cell that would run as a spreadsheet formula starts with an apostrophe so it stays text), and Findings has a print stylesheet for Save-as-PDF.

### Shell

**Command palette** (⌘K / Ctrl+K, or the search button in the top bar): a single ARIA combobox
over navigation to every section (grouped as in the sidebar), switching accounts, setting the
theme, collapsing the sidebar, refreshing the current section, saved views, disconnecting, and —
when the typed text looks like a Ray ID (16 hex characters, optionally with a `-XXX` colo suffix)
— tracing it. Matching is fuzzy/substring with matched characters highlighted, and recently used
commands sort first. Both the palette and the sidebar read navigation from one place,
[web/src/components/shell/nav.ts](web/src/components/shell/nav.ts), so a route can't be added to
one and forgotten in the other — enforced by
[tests/nav-groups.test.ts](tests/nav-groups.test.ts).

**Saved views** are a name plus the full hash you were standing on (route, zone, range, tab —
whatever that section put in the URL) and the account it was saved under. Save one from the
bookmark button in the top bar or the palette's "Save current view…" command; find them again in
the sidebar's collapsible **Saved views** group (rename and delete inline) or under "Saved views"
in the palette. Stored in `localStorage` under `flarelens_saved_views`
([web/src/lib/savedViews.ts](web/src/lib/savedViews.ts)), scoped per account, capped at 50 per
account, and validated on read so a malformed entry is dropped rather than breaking the list.
They are workspace preferences, not telemetry, so disconnecting does not clear them — only
listing does, per account.

**Theme** is dark, light, or system, cycled from the top bar's theme button (dark → light →
system) or set directly from the palette; "system" follows `prefers-color-scheme` live.
Existing users default to dark, not system. First paint reads the saved theme before React
mounts via a small blocking script,
[web/public/theme-init.js](web/public/theme-init.js) (the CSP is `script-src 'self'` with no
inline scripts, so it has to be a same-origin file rather than an inline `<script>`), which is
why `web/index.html` loads it in `<head>` ahead of the app bundle.

## Architecture

```
src/index.ts                 Hono worker entrypoint: creates the app, security-header middleware,
                             calls every routes/*.ts register*Routes() in order, asset fallback
src/env.ts                   Env bindings interface, App = Hono<{ Bindings: Env }> type
src/http.ts                  Route helpers shared by routes/*.ts: validHexId, cache headers,
                             filterAllowedAccounts, SECURITY_HEADERS
src/cf-types.ts              Cloudflare API shapes shared by more than one route module
src/routes/                  One module per /api area, each exporting register<Area>Routes(app);
                             see the file for the full list (core, access, waf, ai-security, …)
src/lib/auth.ts              Credential resolution: Access JWT verification, account/zone allowlist
src/lib/waf-meta.ts          Ruleset metadata flattening (managed/custom, entrypoints)
src/lib/cache-analysis.ts    GraphQL analytics, last-match attribution, insights, grade
src/lib/access-usage.ts      Access login telemetry
src/lib/gateway-usage.ts     Zero Trust Gateway DNS + HTTP telemetry
src/lib/workers-analytics.ts Workers invocation metrics
src/lib/workers-ai.ts        Workers AI inference metrics
src/lib/ai-gateway.ts        AI Gateway proxy usage, field names resolved from the live schema
src/lib/access-tunnels.ts    Tunnel Map: hostname → Access app → tunnel → origin join
src/lib/pqc.ts               PQC readiness verdicts, TLS posture, cipher grading
src/lib/pqc-adoption.ts      Measured post-quantum key-exchange adoption (schema-probed)
src/lib/request-trace.ts     Ray ID forensics with schema sweep and adaptive retry
src/lib/zone-health.ts       Zone Health: certificate expiry and DNS hygiene
src/lib/gateway-policies.ts  Gateway Policies: rules grouped/ordered by documented enforcement stage,
                             the narrow "never runs" claim, and findings — see the file for doc cites
src/lib/dns-records.ts       DNS Records: account-wide flattening, exposed-origin flag, per-zone errors
src/lib/ratelimit-bot.ts     Rate Limits & Bots: rate-limit rule review, bot management settings
web/src/features/tunnels/sankey.ts
                             Flow-diagram layout for the Tunnel Map (pure geometry, unit-tested)
src/lib/cf-rest.ts           Shared Cloudflare REST plumbing: base URL, authHeaders, fetchCloudflare(All),
                             paginated list read, bounded fan-out
src/lib/edge-cache.ts        60s per-credential Cache API layer for configuration reads
src/lib/ai-sec/              AI Security: zone fan-out, schema probing, domain aggregation
web/                         Vite + React 19 + Tailwind 4 + TanStack Table SPA
web/src/hooks/useTimeRange.ts   Shared analytics window, clamped per section
web/src/components/chart/       Inline-SVG hover readout used by every chart
web/src/features/ai-security/matchedData.ts
                             HPKE decryption of logged prompts, browser-side only
web/src/lib/expr.ts          Wirefilter expression evaluator (single source; the
                             worker imports it for attribution, the client for the URL tester)
web/src/lib/ui.ts            Style tokens — the single definition of cards, alerts, buttons, focus rings
web/src/lib/savedViews.ts    Saved views: read/write/validate against localStorage, scoped per account
web/src/components/          PageShell, StatCard, EmptyState, Tabs, LoadingVeil, ProgressBar, shell
web/src/components/shell/nav.ts
                             NAV_GROUPS — the one source the sidebar and command palette both read
web/src/components/shell/CommandPalette.tsx
                             ⌘K command palette: navigation, account switch, theme, saved views, Ray ID trace
web/public/theme-init.js     Blocking pre-mount script that sets the real theme before first paint
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

Every section renders inside [PageShell](web/src/components/PageShell.tsx), which owns the
`h-full overflow-auto` that makes the section its own scroll container; a section outside it is
clipped by `<main>` with no way to reach the rest of its content. Applications is the one
deliberate exception — its table owns the scrolling so the header can stay put — and the test
pins the exception as well, so it stays a decision rather than drift.

### One of everything

Anything that appears on more than one page has exactly one definition:
[web/src/lib/ui.ts](web/src/lib/ui.ts) for style tokens (cards, alerts, buttons, inputs, badges,
focus rings) and `web/src/components/` for `PageShell`, `StatCard`, `EmptyState` and `Tabs`.
Refresh lives only in the top bar; a section registers what reloading means for it through
[useSectionRefresh](web/src/hooks/useSectionRefresh.ts).

This is enforced rather than documented. A second `StatCard`, an empty state with its own shape,
or a `Refresh` button inside a page fails
[tests/components/shared-ui.test.tsx](tests/components/shared-ui.test.tsx) or
[tests/refresh-affordance.test.ts](tests/refresh-affordance.test.ts) — because the previous drift
did not come from carelessness, it came from each new page copying whichever page its author
happened to open, and a style guide does not stop that.

### Loading

Every section loads behind [LoadingVeil](web/src/components/LoadingVeil.tsx): a progress bar with
a caption, above content dimmed while it goes stale. There are no server-side progress events, so
the bar is estimated from how long that section's last load actually took. The caption follows
one rule — never report a number the app cannot stand behind: a countdown appears only when the
estimate came from a measured load and is still ahead of the clock; the first load of a section
shows elapsed time, and a load that outruns its estimate says it is taking longer than usual
rather than sitting at "0s". Content is dimmed, not disabled, because what is on screen during a
reload is real data the reader may still want.

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
| Analytics: Read | Prompt injection, PII and topic detections in AI Security; Access Usage, Gateway Usage, Workers Analytics, Workers AI, AI Gateway and Cost & Usage all read account-scoped GraphQL datasets behind this, as does the Applications page's Logins (7d) column — which degrades to a dash and a stated reason without it |
| Cloudflare Tunnel: Read | Tunnel names, status and ingress rules in the Tunnel Map, and the private network routes. **Cloudflare returns an empty list rather than a 403 when this is missing**, so without it the page cannot tell an account with no tunnels from a token that cannot see them — it says so rather than showing a blank map |
| Zero Trust: Read | Resolves a policy rule referencing a Zero Trust list (`Email in list …`) to that list's name, size and entries — without it the rule still renders, carrying the bare list id. Also the account's Gateway rules (DNS, DNS resolver, network and HTTP policies) in Gateway Policies |
| Zone: DNS: Read | The hostname inventory behind PQC Readiness. Without it each zone is still listed, carrying its own error and no hostnames, rather than the page reporting a clean but empty account |
| Zone Settings: Read | TLS 1.3, minimum TLS version and SSL mode, which every PQC verdict depends on. Cloudflare answers a token without it with `Unauthorized to access requested resource`, and the page reports each zone's settings as unreadable rather than assuming a default |
| Workers Scripts: Read | Adds workers with no traffic in the window to the Workers Analytics filter, and lets the Tunnel Map identify an Access application served by a Worker on a custom domain instead of reporting it as having no route. Both degrade rather than fail without it |
| SSL and Certificates: Read | Certificate expiry in Zone Health (edge certificate packs and uploaded certificates). Cloudflare answers a token without it with error 9109, and each source is reported as not checked, naming this scope — never as a zone with no certificates |
| Zone: Bot Management: Read | Bot management settings in Rate Limits & Bots. Without it a zone's settings are reported as not checked, naming the missing scope |
| Account WAF: Read / Zone WAF: Read | Rate-limit rules in Rate Limits & Bots, read from the `http_ratelimit` phase entrypoint ruleset the same way WAF Analytics reads the custom-firewall entrypoint. This app's understanding of which scope gates that read, not a Cloudflare-confirmed mapping — unverified against a live account |

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

### Configuring a deployment

`wrangler.jsonc` ships **placeholder** account, zone and Access identifiers so this repository
carries no deployment's configuration. Fill them in, or keep your real values out of git entirely:

```bash
cp wrangler.jsonc wrangler.local.jsonc   # edit with your ids; the file is gitignored
npm run deploy:live                      # deploys with wrangler.local.jsonc
```

`npm run deploy` uses the committed `wrangler.jsonc`, which will not deploy anywhere real until
its placeholders are replaced. Secrets never belong in either file — `CF_API_TOKEN` is set with
`wrangler secret put CF_API_TOKEN`, and the E2E suite reads its Access service token from a
gitignored `.dev.vars`.

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

### Configuration reads are cached for 60 seconds

`/api/zones`, `/api/access/tunnels`, `/api/pqc/report` and `/api/zone-health/report` take 0.5–4s
upstream for configuration that changes on the order of minutes, so the Worker holds each response
in the Cache API for 60 seconds. Measured against the live account: repeat loads drop from ~4s to
~5ms.

The key is `auth mode + SHA-256 fingerprint of the resolved credential + path + validated params`.
Two BYOT tokens never share an entry; in server mode every operator shares the bound token and the
same allowlist, so sharing is correct. The cache is consulted only after authentication, input
validation and the allowlist have all passed — `tests/routes-auth.test.ts` asserts a refused scope
triggers no cache lookup or write on every scoped route. Only `success: true` responses are stored.

The top bar's **Sync** sends `X-Flarelens-Fresh: 1`, which bypasses and refreshes the entry; opening
a page or switching accounts takes the cached read. A page showing cached data says so, with the
clock time it was cached. Browser responses remain `Cache-Control: no-store`.

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

**Domain-verification CNAMEs point at names that do not exist, on purpose.** Google's
`*.dv.googlehosted.com`, AWS Certificate Manager's `*.acm-validations.aws`, and the equivalents
from GoDaddy, DigiCert and Sectigo are read as records by the verifier; the targets never resolve.
Measured 2026-09-14: one returned NXDOMAIN and was initially reported by Zone Health as a high
subdomain-takeover risk. Nothing can be taken over there, so those targets are skipped and counted.
A dangling CNAME is otherwise NXDOMAIN (DoH `Status: 3`) and nothing else — an existing name answers
`Status: 0` even with zero records.

**`http_only_cookie_attribute: false` is real.** 23 of 29 applications on this account return it,
which looked like a default rather than a setting. Checked against the live `CF_Authorization`
Set-Cookie header on 2026-09-14: the cookie indeed carries no `HttpOnly` flag, so the finding stands.

**The applications list already carries every application's policies.** `GET
/accounts/{id}/access/apps` embeds full policy objects — rules, decision, precedence, `reusable` —
identical field for field to `/access/apps/{app}/policies` (checked for all 29 apps on this
account, 2026-09-12). Fetching them again per application cost about six seconds per load on 29
apps. The one exception is the `private_ip` type, which omits the field entirely; its per-app
endpoint returns nothing either, but an absent field and an empty policy list are different
facts, so those apps are still asked about individually rather than assumed.

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

**Measured adoption is available through GraphQL** — verified 2026-09-08. Cloudflare documents
`ClientTLSKeyExchangeGroup` as a Logpush field, but `httpRequestsAdaptiveGroups` also exposes it
as the `clientTLSKeyExchangeGroup` dimension, so PQC Readiness reports observed adoption without
Log Explorer's stored-logs cost. The Worker still probes for it rather than hardcoding the name:
if the dimension is absent the section says so and names Log Explorer as the alternative, because
a zero and an absence must never look the same.

**A schema field can be real, well-named and still answer a different question.** AI Gateway's
requests dataset exposes `tokensIn` alongside `cachedTokensIn` and `uncachedTokensIn`, and `cost`
alongside `abnormalCostSessions`. A pattern match for the obvious shape picked the wrong field in
both cases and reported a confident zero rather than an error. Field resolution there names its
candidates in priority order for that reason, and the API response carries both the resolved
names and the lists they were chosen from.

**Cipher suites and key agreement are separate axes.** The zone `ciphers` setting selects
allowed suites for **TLS 1.0–1.2 only** — TLS 1.3 suites are fixed and cannot be configured — so
it never changes a PQC verdict. It is graded anyway because it carries the same exposure by
another route: a suite without an `ECDHE-`/`DHE-` prefix has no forward secrecy, so traffic
recorded today stays readable to whoever later obtains the certificate's private key, quantum
computer or not. An empty list means Cloudflare's defaults and is reported as such, not graded:
customising needs Advanced Certificate Manager, the defaults are not visible through the API, and
marking a zone down for a list it cannot see or edit would be noise.

**How far back each section can look, and why.** Measured against this account on 2026-09-12,
not assumed — the ceilings are Cloudflare's and vary by plan:

| Section | App's cap | Ceiling |
|---|---|---|
| Access Usage, and the Applications `Logins (7d)` column | 7 days | **The dataset's own cap.** `accessLoginRequestsAdaptiveGroups` refuses a wider range; nothing in configuration raises it |
| WAF Analytics | 30 days | `firewallEventsAdaptive` retention: 24h on Free/Pro, 3 days on Business, 30 days on Enterprise |
| Gateway, Workers, Workers AI, AI Gateway | 30 days | app-imposed; the datasets allow more on higher plans |
| Cache Rules | 24h / 7d / 30d | app-imposed |
| PQC measured adoption | 24 hours | app-imposed; `httpRequestsAdaptive` retention runs to 90 days on Enterprise |

So a question like "has anyone signed into this application this quarter" is **not answerable
through this API at all** — seven days is the wall, and the only way past it is Log Explorer with
`access_requests` stored, which is a stored-logs decision rather than a code change.

**A wider WAF window returns fewer events, not more.** Measured on the same account, minutes
apart:

```
 7-day window → 18,440 events across  8 distinct days
30-day window →  5,388 events across 31 distinct days
```

The 30-day result should be a superset of the 7-day one and is not. It is not sampling —
`sampleInterval` is absent on every row — and the app's pagination completed in both cases,
well under its 5 × 10k cap, so Cloudflare is serving a sparser set for the wider window. The
mechanism is unknown and is deliberately not guessed at here. The consequence is firm regardless:
**WAF event counts are not comparable across window sizes**, and a 30-day WAF view is a sparse
sample rather than a complete history. Do not read month-over-month trends from it.

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
network unless you ask it to. Vitest runs two `test.projects`: a `node` project for everything
below except Component, and a `jsdom` project (real DOM, `@testing-library/react`) for Component —
kept separate so the Worker route tests keep their Workers-shaped globals and the component tests
get a real browser-like environment, without either leaking into the other.

| Layer | Files | What it covers |
|---|---|---|
| Unit | `tests/{expr,rules,csv,findings,cache-analysis,waf-meta,waf-aggregate,waf-chart,hash-params,auth,chart-hover,pqc,tunnel-sankey,dns-records,ratelimit-bot,nav-groups,waf-evaluation}.test.ts`, `tests/ai-sec-*.test.ts` | Pure logic: wirefilter evaluation, rule rendering, findings, CSV, WAF aggregation and bucketing, hash deep-link helpers, Access JWT verification, chart hover placement, PQC verdicts, the Tunnel Map flow diagram's geometry (every column sums to the row count, no band overflows its node), the DNS Records builder (exposed-origin flag, TTL formatting, per-zone errors kept rather than dropped), the AI Security domain layer including `buildDashboard`, Rate Limits & Bots' 404-vs-403 distinction, plan-tier inference and findings, and that `NAV_GROUPS` covers every `Route` from `useRoute` exactly once |
| Component | `tests/components/{PqcPage,ConnectPage,AppsTable,GroupsPage,shared-ui,tabs,progress,estimated-progress,ZoneHealthPage,DnsPage,BotsPage,GatewayPoliciesPage,CommandPalette,savedViews,theme,RulesReview,TunnelDrawer,storage}.test.tsx` | Actually rendered React components (jsdom + Testing Library, `tests/components/setup.ts`): page behaviour for PQC, Connect, Applications, Groups, DNS Records, Rate Limits & Bots and Gateway Policies; the shared StatCard/EmptyState and the rule that no page redefines them; the ARIA tabs contract; the loading caption's honesty rules and estimate bookkeeping; the command palette's combobox keyboard contract, fuzzy filtering and Ray ID detection; saved views' per-account scoping, cap and malformed-entry handling against a real (and a throwing) `localStorage`; and theme cycling plus "system" following `matchMedia` live |
| Integration | `tests/integration-ai-security.test.ts` | The AI route wired to the ported library, Cloudflare client and Cache API, with only the network mocked — including cache-key tenant isolation |
| System | `tests/system-routes.test.ts`, `tests/{access-usage,gateway-usage,workers-analytics,workers-ai,ai-gateway,access-tunnels,request-trace,data-fanout,zone-health,gateway-policies,dns-records,ratelimit-bot,edge-cache}.test.ts` | Every route through the real app against one mocked Cloudflare: response shapes, validation, upstream error mapping, and the cross-cutting header and `no-store` contract. `ai-gateway.test.ts` covers per-dataset degradation when a field does not resolve; `data-fanout.test.ts` pins the embedded-policy read and the concurrent tunnel fetches; `ratelimit-bot.test.ts` also carries `GET /api/bots/report`'s route tests alongside its lib unit tests; `gateway-policies.test.ts` carries both `GET /api/gateway/policies`'s route tests and the enforcement-stage/finding lib unit tests |
| Compatibility | `tests/compat-upstream-shapes.test.ts` | Upstream drift the app does not control: pagination, partial-scope tokens, unknown detection categories, non-JSON responses, and the Workers globals Node lacks |
| Security | `tests/security-boundaries.test.ts`, `tests/routes-auth.test.ts`, `tests/no-adhoc-auth.test.ts`, `tests/matched-data.test.ts` | The adversarial half: credential confinement, allowlist evasion, input handling, the guardrail keeping credential resolution in one module, and the prompt-decryption boundaries — key never stored, never sent, never exported. `routes-auth.test.ts` also requires every account- or zone-scoped route to refuse a non-allowlisted scope with no upstream call and no cache access — checked against a mutant with the check deleted from each route |
| Regression | `tests/shell-layout.test.ts`, `tests/refresh-affordance.test.ts`, `tests/apps-export.test.ts`, `tests/error-boundary.test.ts`, `tests/waf-wide-window.test.ts`, `tests/app-server-mode-accounts.test.ts`, `tests/tsconfig-references.test.ts` | Failures with no runtime error to catch them: the flex height chain and PageShell as the sole scroller, refresh living only in the top bar, CSV exporting rendered text rather than raw JSON, and the error-boundary message formatter |
| E2E | `tests/e2e-live.test.ts` | The deployed Worker through real Cloudflare Access with the bound token. **Opt-in** |

Some suites assert against source text rather than behaviour — that a page has its own scroll
container, that no module outside `src/lib/auth.ts` reads the `Authorization` header, that the
decryption key never reaches storage.

Tests are type-checked by `tsc -b` like the source: `tests/tsconfig.json` (Workers types, no DOM)
and `tests/components/tsconfig.json` (DOM, JSX) reference the projects they import, so a fixture
that drifts from a real type fails the build rather than passing quietly. Those properties have no observable failure mode in a Node
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
| `npm run deploy` | Build then `wrangler deploy` with the placeholder `wrangler.jsonc` |
| `npm run deploy:live` | Build then deploy with the gitignored `wrangler.local.jsonc` — the real deployment |

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

Behind TLS inspection the proxy fails with `self-signed certificate in certificate chain`, because
Node does not use the system trust store; add `secure: false` to the proxy entry for the session.

Never commit the proxy: it sends a live credential from a config file that is not gitignored.

## Data-honesty notes (Cache section)

Inherited from the original cf-cache-analyzer: hit ratio counts `hit + stale + updating + revalidated` as served (Cloudflare-consistent); traffic matching no path-evaluable rule is shown as an explicit *unattributed* block, never redistributed; analytics failures fall back to clearly-labeled simulated data; a genuinely quiet zone shows zeros, not mocks.
