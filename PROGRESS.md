# Flarelens — Progress

Status snapshot, last reviewed **2026-09-13** against a full read of the tree, a live probe of
the deployed API, and a UI/UX consistency pass across every section. See [README.md](README.md) for how to run the app; this file tracks where the
work stands.

**TL;DR** — Fifteen sections, 613 tests green, `tsc -b` clean, 0 lint errors (4 known warnings).
**Deployed and live** at `flarelens.example.com`, behind Cloudflare Access, running in server
mode: the Worker holds a read-only `CF_API_TOKEN` and Access authenticates operators, so the UI
no longer asks for a token. Every section has now been exercised against real account data
through an Access service token, AI Gateway included — its field names are resolved from the
schema at runtime rather than guessed, and returned real traffic on 2026-09-08.
Running version `db28da07`, deployed 2026-09-09 16:11 UTC.

Source lives at `bkrbybk-org/flarelens` (public). `wrangler.jsonc` carries placeholder account,
zone and Access ids; the real deployment config is the gitignored `wrangler.local.jsonc`, used by
`npm run deploy:live`. GitHub Actions runs `npm run check` and `npm run lint` on every push and
pull request; there is no deploy job, deliberately — see the note under Recently resolved.
---

## Sections

Fifteen routes, grouped in the sidebar by Cloudflare product area:

| Group | Routes |
|---|---|
| Zero Trust | `#/access`, `#/groups`, `#/access-usage`, `#/tunnels`, `#/gateway` |
| Security | `#/waf`, `#/ai-security`, `#/request`, `#/pqc` |
| Performance | `#/cache` |
| Developer Platform | `#/workers`, `#/workers-ai`, `#/ai-gateway`, `#/cost` |
| Audit | `#/findings` |

All time-windowed sections share one range picker in the top bar (`hooks/useTimeRange.ts`),
stored in minutes and clamped per section to whatever its upstream dataset allows — Access Usage
to 7 days, Cache to 24h/7d/30d, WAF to the Worker's own bounds.

The analytics sections that read login, Gateway or AI telemetry are **aggregate only**: the
datasets expose `userUuid`, `email`, `ipAddress` and `deviceId`, and none of them are queried.
Tests assert those field names never appear in an outgoing GraphQL document.

The one place prompt content is shown is the AI Security events table, and it is decrypted in the
browser with a payload-logging private key the operator supplies per session — never stored, never
sent to the Worker, which only ever handles ciphertext.

---

## Architecture

### Request flow

```
browser ──► Worker (Hono, src/index.ts) ──► api.cloudflare.com
              │                              (REST + GraphQL)
              └─► ASSETS binding ──► web/dist (Vite build)
```

`assets.run_worker_first: true` means the Worker sees every request first, so security headers and CSP land on the HTML document too — not just API responses.

Credentials resolve at one choke point, [src/lib/auth.ts](src/lib/auth.ts). A request carrying
`Authorization: Bearer` is BYOT: the Worker forwards that token upstream within the same
invocation and holds nothing. A request without one is server mode, which this deployment uses:
the Worker's own read-only `CF_API_TOKEN` secret is used, but only after a Cloudflare Access JWT
verifies and only for accounts and zones on the deploy-time allowlist. A Bearer header always
wins, so a caller's own token can never be silently upgraded to the bound one.

Storage is therefore not quite "nothing": a `CF_API_TOKEN` secret (no KV, no D1), and the AI
Security layer writes per-zone results to the edge Cache API, namespaced by a SHA-256 fingerprint
of the calling token — see the P2 entry below.

### API routes ([src/index.ts](src/index.ts))

| Route | Scope | Consumed by |
|---|---|---|
| `GET /health` | — | uptime checks |
| `GET /api/accounts` | account | connect screen, account switcher |
| `GET /api/zones` | account | zone picker (WAF + Cache) |
| `GET /api/data` | account | Access Applications, Access Groups |
| `POST /api/waf/events` | account or zone | WAF Analytics (firewallEventsAdaptive, cursor-paginated 5×10k, deduped) |
| `GET /api/waf/rulesets` | account or zone | WAF Analytics (ruleset metadata) |
| `POST /api/cache/analyze` | zone | Cache Rules (rules + GraphQL analytics + attribution + insights) |
| `GET /api/config` | — | SPA bootstrap: credential mode, allowlisted accounts, running version. Answers `byot` rather than 401 when the Access gate does not pass, so an unauthenticated caller learns nothing about the deployment |
| `POST /api/ai-security/analyze` | account or zone | AI Security (one fan-out builds every panel) |
| `POST /api/access/usage` | account | Access Usage. Upstream caps this dataset at 1 week |
| `POST /api/request/trace` | account or zone | Request Trace — Ray ID lookup across zones, schema-driven field selection |
| `GET /api/pqc/report` | account (optional zone) | PQC Readiness — zones, their TLS settings, and every A/AAAA/CNAME record classified per TLS leg |
| `GET /api/access/tunnels` | account | Tunnel Map — joins Access apps, their policies (reusable ones resolved), tunnel ingress rules and private routes |
| `POST /api/gateway/usage` | account | Gateway Usage (DNS resolver + Gateway HTTP) |
| `GET /api/workers/scripts` | account | Workers Analytics filter — needs `Workers Scripts: Read`, degrades if absent |
| `POST /api/workers/metrics` | account | Workers Analytics; also half of Cost & Usage |
| `POST /api/workers-ai/usage` | account | Workers AI; also half of Cost & Usage |
| `POST /api/ai-gateway/usage` | account | AI Gateway (proxy requests, tokens, errors, cache, spend). **Field names unverified** — see [src/lib/ai-gateway.ts](src/lib/ai-gateway.ts) |
| `app.all("*")` | — | static asset fallback |

All `/api/*` responses carry `Cache-Control: no-store`. Invalid IDs → 400, missing/bad token →
401/403, disallowed account or zone → 403 before any upstream call, upstream failure → 502.

Every route that takes a time window parses both bounds into ISO instants and re-emits them
through `toISOString()`. That is the injection boundary: the bounds are interpolated into GraphQL
documents, so no caller text reaches a query.

`/api/waf/rulesets` fetches its scopes (account + one per zone) with bounded concurrency, each into its own map, then merges them in original scope order — so zone entries still override account entries for the same rule id regardless of which request finishes first.

### Modules

| Path | Role |
|---|---|
| [src/lib/waf-meta.ts](src/lib/waf-meta.ts) | Flattens rulesets (account + zone scopes, managed `execute` targets, custom firewall entrypoint) into a rule-id/ref keyed map |
| [src/lib/cache-analysis.ts](src/lib/cache-analysis.ts) | Cache GraphQL queries, last-match attribution, insights, A–F health grade, labeled mock fallback |
| [src/lib/cache-cf-types.ts](src/lib/cache-cf-types.ts) | Cloudflare REST/GraphQL response shapes for the cache path |
| [src/lib/auth.ts](src/lib/auth.ts) | Credential resolution for every route: Access JWT verification against the team JWKS, BYOT-wins precedence, account/zone allowlist |
| [src/lib/access-usage.ts](src/lib/access-usage.ts) | Access login telemetry; folds success/failure rows and resolves app/IdP uuids to names |
| [src/lib/gateway-usage.ts](src/lib/gateway-usage.ts) | Gateway DNS + HTTP telemetry; conservative block classification, multi-value category handling |
| [src/lib/access-tunnels.ts](src/lib/access-tunnels.ts) | Tunnel Map: joins Access apps, tunnel ingress and private routes, and classifies each destination's origin kind |
| [src/lib/pqc.ts](src/lib/pqc.ts) | Post-quantum readiness: zone TLS settings + DNS inventory + tunnel and Worker origins, classified into two legs and one verdict, plus `gradeCipher`/`summariseCiphers` for the zone's TLS 1.0–1.2 suite list. `buildPqcReport` is pure and carries the classification rules |
| [src/lib/pqc-adoption.ts](src/lib/pqc-adoption.ts) | Measured post-quantum adoption: introspects `httpRequestsAdaptiveGroups` for a key-exchange dimension, matched by shape rather than one spelling, then reports per-hostname adoption or states why it cannot. A cipher or protocol dimension deliberately does not match |
| [src/lib/request-trace.ts](src/lib/request-trace.ts) | Ray ID forensics: schema-swept field selection, adaptive retry around per-zone entitlements and Cloudflare's field ceiling |
| [src/lib/workers-analytics.ts](src/lib/workers-analytics.ts) | Workers invocation metrics; script list degrades when the scope is absent |
| [src/lib/workers-ai.ts](src/lib/workers-ai.ts) | Workers AI inference metrics; folds rows split by `errorCode` |
| [src/lib/ai-gateway.ts](src/lib/ai-gateway.ts) | AI Gateway proxy usage across four `aiGateway*AdaptiveGroups` datasets. Dataset, dimension and aggregate names are **resolved from the live schema at runtime** (`resolveAiGatewayFields`, 10-minute module cache) and the response carries the `candidates` it chose between, so a wrong resolution is diagnosable rather than a confident zero. The requests dataset is load-bearing (throws on failure); errors/cache/spend degrade independently, each reporting `{ available, reason }` |
| [src/lib/ai-sec/](src/lib/ai-sec/) | AI Security: zone fan-out, schema-capability probing, per-token edge caching of the **aggregate half only** (rows are never cached), and the `buildDashboard` aggregation |
| [web/src/hooks/useTimeRange.ts](web/src/hooks/useTimeRange.ts) | Shared analytics window in minutes, hash-synced, clamped per section |
| [web/src/components/chart/ChartHover.tsx](web/src/components/chart/ChartHover.tsx) | Hover readout for every inline-SVG chart: bucket hit-testing and measured, clamped placement |
| [web/src/features/ai-security/matchedData.ts](web/src/features/ai-security/matchedData.ts) | HPKE decryption of logged prompts. Browser-only; the key never reaches the Worker or storage |
| [web/src/lib/expr.ts](web/src/lib/expr.ts) | **Wirefilter evaluator — single source.** Worker imports it for attribution (strict boolean); client imports it for the URL tester (Kleene tri-state). Pulled into the Worker build via the `web/src/lib/expr.ts` entry in `tsconfig.worker.json` |
| [web/src/lib/waf/](web/src/lib/waf/) | `aggregate` (correlation, action drift, per-rule detail), `chart` (bucketing), `format`, `constants`, `types` |
| [web/src/lib/rules.ts](web/src/lib/rules.ts) | Access rule vocabulary (`describeRule`, ~20 rule types), `resolvePolicy`, decision tones |
| [web/src/lib/findings.ts](web/src/lib/findings.ts) | Pure audit checks per source (`accessFindings`, `groupsFindings`, `wafFindings`, `cacheFindings`), plus the shared `groupUsedBy` cross-reference |
| [web/src/lib/csv.ts](web/src/lib/csv.ts) | RFC 4180 `toCsv` + `downloadCsv` (quotes fields containing commas/quotes/newlines) |
| [web/src/lib/sectionSnapshot.ts](web/src/lib/sectionSnapshot.ts) | Account-scoped cross-page store carrying the last WAF/Cache load to Findings — see the note under Frontend |
| [web/src/lib/ui.ts](web/src/lib/ui.ts) | **Style tokens — single source.** `CARD`, `ALERT_ERROR`/`ALERT_WARN`, `BTN_*`, `INPUT`/`SEARCH_INPUT`/`SELECT`, `BADGE`, `MUTED`, `SECTION_TITLE`, `FOCUS_RING`/`FOCUS_ROW`. Adding a second token for one role is a bug, not a choice |
| [web/src/components/PageShell.tsx](web/src/components/PageShell.tsx) | The frame every section renders inside: `h-full overflow-auto` + `space-y-4 p-4 md:p-6`. Applications is the deliberate exception — its table owns the scrolling |
| [web/src/components/StatCard.tsx](web/src/components/StatCard.tsx) | `StatCard` (label over value, optional icon/hint/tone; formats numbers itself) and `StatGrid` (two columns on a phone, `cols` at `lg`) |
| [web/src/components/EmptyState.tsx](web/src/components/EmptyState.tsx) | `EmptyState` (page), `EmptyNote` (inside a card), `EmptyRow` (inside a table). `loading` is a separate state from empty |
| [web/src/components/Tabs.tsx](web/src/components/Tabs.tsx) | The full ARIA tabs contract: `aria-controls`/`aria-labelledby` both ways, roving tabindex, Left/Right/Home/End with wrapping |
| [web/src/hooks/useSectionRefresh.ts](web/src/hooks/useSectionRefresh.ts) | Lets the mounted section register its reload so the top bar's Sync can drive it; single slot, cleared on unmount |

### Frontend

React 19 + Vite 8 + Tailwind 4 + TanStack Table 8. Feature-folder layout under `web/src/features/{access,waf,cache,findings}/`, shared UI in `web/src/components/` (`PageShell`, `StatCard`, `EmptyState`, `Tabs`, `ProgressBar`, `table/ColumnFilterPopover`, `Icons`, `shell/{Sidebar,Topbar}`).

**One of everything.** Sections used to disagree about their own shape: two page frames, two stat-card
layouts, four empty states with four voices, two sizes of error banner, and a refresh control that
lived in the top bar on three sections and inside the page on eleven. That drift was structural — a
new section inherited whichever section its author had copied — so the fix is a shared component
plus a test that fails when a second copy appears, not a style guide. See
[web/src/lib/ui.ts](web/src/lib/ui.ts) for the tokens and
[tests/components/shared-ui.test.tsx](tests/components/shared-ui.test.tsx),
[tests/refresh-affordance.test.ts](tests/refresh-affordance.test.ts) and
[tests/shell-layout.test.ts](tests/shell-layout.test.ts) for the pins.

Routing is hash-based with no router dependency — [useRoute.ts](web/src/hooks/useRoute.ts) parses the path segment, [useHashParams.ts](web/src/hooks/useHashParams.ts) syncs query params. Five sections: `#/access`, `#/groups`, `#/waf`, `#/cache`, `#/findings`. Deep links like `#/waf?zone=…&lookback=1440&tab=rules` win over saved prefs on load, then mirror state back via `replaceState`.

**Hooks**

| Hook | Responsibility |
|---|---|
| [useSession](web/src/hooks/useSession.ts) | Token + account in sessionStorage |
| [usePrefs](web/src/hooks/usePrefs.ts) | Theme, density, columns, page size, zone selections (localStorage, versioned) |
| [useRoute](web/src/hooks/useRoute.ts) / [useHashParams](web/src/hooks/useHashParams.ts) | Hash routing + deep-linkable state |
| [useZones](web/src/hooks/useZones.ts) | Lazy zone list, cached per account |
| [useZeroTrustData](web/src/hooks/useZeroTrustData.ts) / [useWafData](web/src/features/waf/useWafData.ts) / [useCacheData](web/src/features/cache/useCacheData.ts) | Per-section fetch + state |
| [useEstimatedProgress](web/src/hooks/useEstimatedProgress.ts) | Progress bar estimated from the last real load duration |
| [useSectionRefresh](web/src/hooks/useSectionRefresh.ts) | Puts the mounted section's reload behind the top bar's Sync button |

**Cross-page snapshots.** WAF and Cache data lives in their pages' hooks, which unmount on
navigation, so [sectionSnapshot.ts](web/src/lib/sectionSnapshot.ts) carries the last load
across to the Findings page without lifting state into `App` or re-fetching. Snapshots are
**stamped with the account that captured them** and readers pass the account they expect —
without that guard a snapshot keeps being reported under the next customer you switch to.
Disconnect clears the store.

> **Hook contract:** the three data hooks keep `load` referentially stable (callbacks held in refs, progress fns destructured) so page effects can list it in their dependency arrays. Don't reintroduce `onAuthError` into a `useCallback` dep list — it re-fires the effect on every parent render.

### Client storage

| Key | Store | Notes |
|---|---|---|
| `cf_api_token`, `cf_account_id`, `cf_account_name` | sessionStorage | Cleared on tab close; never persisted to disk |
| `cf_zt_prefs` | localStorage | `PREFS_VERSION = 3`; a version bump discards saved column order/visibility so new defaults apply. The policies table keeps its own `policyColumnVisibility` / `policyColumnOrder` keys: it shares column ids (`name`, `updated_at`, `id`) with the applications table, so one saved order would scramble the other |
| `cf_zt_last_load_ms`, `cf_waf_last_load_ms`, `cf_cache_last_load_ms` | sessionStorage | Rolling load-duration estimates for the progress bar |

### Tests

`npm test` (Vitest `test.projects`: a `node` project, `environment: "node"`, pure logic only, no
DOM; and a `component` project, `environment: "jsdom"` + `@testing-library/react`, for actually
rendered components — `tests/components/setup.ts` wires jest-dom matchers and RTL's auto-cleanup
into that project only, so the node project's Workers-shaped globals stay untouched).

| File | Covers |
|---|---|
| `tests/expr.test.ts` | Wirefilter evaluator: operators, functions, Kleene tri-state laws, `forAttribution` query-field rejection |
| `tests/cache-analysis.test.ts` | Last-match attribution, unattributed block, `topUrls` ranking, insights, A–F grade thresholds |
| `tests/waf-aggregate.test.ts` | Ruleset/rule correlation, action drift, zero-traffic + disabled rules, id/ref dedupe |
| `tests/waf-meta.test.ts` | Merge order survives the concurrent scope fetch |
| `tests/findings.test.ts` | Every audit check, plus the snapshot account-scoping guard |
| `tests/pqc.test.ts` | Every readiness verdict, the inventory filter and ordering, and the route including the DNS-scope degradation |
| `tests/rules.test.ts` | `describeRule` per rule type, `resolvePolicy`, decision tones |
| `tests/csv.test.ts` | RFC 4180 escaping edge cases |
| `tests/components/PqcPage.test.tsx` | Rendered `PqcPage` (fetch mocked at `api/client`'s `fetchPqcReport`): verdict filter chips narrow/restore rows, search matches hostname and zone, a zone-level error renders instead of being swallowed, empty state on no match |
| `tests/components/ConnectPage.test.tsx` | Rendered `ConnectPage`: empty-token submit shows "API Token is required" and calls no fetch; every required/optional permission entry renders |
| `tests/components/AppsTable.test.tsx` | Rendered `AppsTable`: the global search box narrows visible rows and clearing it restores them |
| `tests/components/GroupsPage.test.tsx` | Rendered `GroupsPage`: tab order and deep-linking, the policies table's default sort and search, the created column hidden but selectable, a referenced list's name/size/entries, and an unreadable list stating why |
| `tests/components/shared-ui.test.tsx` | The shared pieces that ended two design generations: number formatting, "loading" vs "empty" staying distinguishable, StatGrid's single breakpoint, and that no page defines its own StatCard, Kpi or EmptyState again |
| `tests/components/tabs.test.tsx` | The ARIA tabs pattern rather than the markup: each tab points at its panel, arrows move and wrap, exactly one tab is in the tab order |
| `tests/refresh-affordance.test.ts` | Refresh exists only in the top bar, every reloadable section registers one, and the registration clears on unmount |
| `tests/ai-gateway.test.ts` | AI Gateway route: series/totals fold, rate arithmetic (never divides by zero), per-dataset degradation when a guessed field name is wrong, validation, auth, `no-store`, 502 on load-bearing failure, and the same "no per-user dimension" privacy assertion as the other aggregate-only sections |

---

## Done

**Foundation**
- `f8b0e64` Zero Trust Access dashboard on Workers (paginated fetches, bounded concurrency, security headers)
- `3066fb1` Full UI rewrite: React sidebar shell, stats, detail drawer, mobile cards, dark/light
- `50c5e1a` Worker routing moved to Hono with byte-for-byte response parity
- `4ae26d7` Feature-folder layout, hash routing, multi-section rebrand

**Merge of the two sibling analyzers**
- `8d0468c` **WAF Analytics** ported from `cf-waf-rules-analyzer` (Preact+signals → React): KPIs, events-over-time chart, ruleset table with expandable child rules, Rules Review, action-drift detection
- `e372f85` **Cache Rules** ported from `cf-cache-analyzer` (vanilla → React): health grade, trend chart, per-rule attribution cards, insights, unattributed block, client-side URL tester
- `53f9562` Zone selection for zone-scoped sections

**Features**
- `2148202` Excel-style per-column filters (facet checkboxes + type-to-search), fixed default column order
- `0715ae2` Table-only scroll with sticky header, revised default columns
- `84d1bcf` Deep-linkable state + account switcher (no disconnect needed)
- `dc99f87` WAF rule drill-down drawer (top paths/hosts/countries/IPs; added `clientCountryName`/`clientIP` to the GraphQL query)
- `8c08c8e` Access Groups section with "used by N applications" cross-references
- `89b4597` Line-by-line permission checklist on connect, with live granted/missing status

**Hardening**
- `277636b` 64 unit tests (expr evaluator incl. Kleene laws, WAF aggregation, cache attribution/insights/grades, rule descriptions) + `expr.ts` deduped to a single source
- `2d8e7e3` Wrangler 4, workers-types 5, README, ESLint flat config — caught 3 real defects (render-time mutation, setState-in-effect, ref-write-during-render)
- `1f396ff` Stable data-hook identities, shared `ProgressBar` across all sections

**Branding / deploy config**
- `60db24b` Renamed to Flarelens · `6636210` Custom domain `flarelens.example.com`, `workers_dev: false`

**Findings, export, performance** (2026-08-02)
- `cdac5e0` WAF ruleset scopes fetched concurrently, merged in scope order (per-scope maps so completion order can't race last-write-wins); first tests for `waf-meta.ts`
- `31c6a5e` **Findings** section — severity-ranked audit view aggregating Access/Groups/WAF/Cache signals, with explicit per-source "not loaded" status lines
- `20dfd05` CSV export (filtered + visible rows only) and a print stylesheet for PDF export
- `9a747ea` Docs brought back in line with the shipped app
- `8c2f04d` Fixed cross-account leakage in the new cross-page snapshot store — see below

**Sections added**
- `fa17935` `767b858` Tunnel Map — Access app → tunnel → origin, with both gaps surfaced (a tunnel ingress nobody gates; a destination with no route). Classifies by application type, because WARP, App Launcher, Browser Isolation, Worker and private destinations legitimately have no tunnel and were all being flagged.
- `bb4efac` `22c4db3` Request Trace — Ray ID forensics across zones. Field selection is swept from the schema rather than hard-coded, with adaptive retry around per-zone entitlements and Cloudflare's 70-field ceiling. Where a payload-logging rule captured the body, it is decrypted in the browser with the AI Security key panel.

- **PQC Readiness** (2026-09-08) — one page answering "which of our names are post-quantum, and
  which are not". Inventory is every A/AAAA/CNAME record across the account's zones; each is
  classified on both TLS legs and given one verdict. Three deliberate calls, all of which make the
  report read worse than a naive one and all of which are correct:
  - A Full-mode origin is **eligible**, never ready. Automatic key exchange prefers
    `X25519MLKEM768` when the origin supports it, but Cloudflare publishes no per-zone scan
    result, so claiming compliance would be inventing evidence.
  - A DNS-only record is **not ready**, not partially covered — Cloudflare terminates no TLS for it.
  - Flexible/Off SSL mode is **not ready** however good the inbound leg is, because the origin leg
    is plain HTTP.
  The deprecated `origin_post_quantum_encryption` API is deliberately not read; Cloudflare
  documents it as a no-op.
  The zone table also grades allowed TLS 1.0–1.2 cipher suites, read from the same settings
  call: forward secrecy and AEAD judged independently, obsolete families (RC4, 3DES,
  export-grade, MD5) called out. It never moves a verdict — cipher selection does not apply to
  TLS 1.3 — and an empty list is reported as “Cloudflare default” rather than graded.
  A "TLS posture" section grades zone hygiene from the same settings call — minimum TLS version,
  Full vs Full (strict), HSTS on/off and max-age, Always Use HTTPS — as a third axis that also
  never moves a verdict: these are classical-TLS configuration choices, not key agreement.

- **PQC measured adoption** (2026-09-08) — the schema question is settled: GraphQL *does* expose
  `clientTLSKeyExchangeGroup` on `httpRequestsAdaptiveGroups`. Live on this account: 2,327
  post-quantum against 5,960 classical over 24h, about 28%, across 60 hostnames. The probe stays
  in rather than being replaced by the literal name, so an account without the dimension gets a
  stated reason instead of a fabricated 0%.

- **AI Gateway verified against real data** (2026-09-08) — 74 requests over 30 days, 16,294 input
  and 2,455 output tokens, $0.0072, 18 errors (24%), 1 cache hit. Getting there took three
  deploys and is the reason the module now resolves field names from the schema by priority-
  ordered exact name: the first guess failed loudly (`unknown field "totalTokensIn"`), and the
  first probe failed *quietly* by matching `cachedTokensIn` and `abnormalCostSessions` — real
  fields that answer different questions and report zero.

- **Access Groups gained tabs** (2026-09-08) — Rule groups and Reusable policies. The account's
  reusable policies were already fetched by `/api/data` and already used to resolve group
  references, but nothing rendered them, so a policy attached to no application was invisible.
  That is the case the new tab calls out by name: it is either dead configuration or a policy
  someone believes is in force. Deep-linkable as `#/groups?tab=groups`.
  Policies lead, as a table modelled on the Applications page: sortable columns (last update
  first, since this page is for review), Excel-style column filters — including a "Not attached"
  facet, the row most worth isolating — search, CSV export and an expandable row for the rules.
  Columns are declared rather than discovered from the row's keys the way AppsTable does it: an
  application is a bag of loosely-related settings, a policy is four things, and its rules are
  nested arrays that make poor columns.

- **Policy list references resolve to their contents** (2026-09-09) — a rule reading
  `Email in list 55e12a45-…` is unreviewable, since the question a policy review asks is who it
  lets in. `/api/data` now resolves the Zero Trust lists a policy references — referenced ones
  only, items capped at 500 — and the rule renders as `Email in list "NTT TH Staff" (42 entries)`
  with the entries expandable inline. A list whose items could not be read says so rather than
  rendering empty, which would read as an empty list. The policies table also gained a column
  selector with drag-to-reorder, saved under its own prefs keys because it shares column ids
  (name, updated_at, id) with the applications table; `created_at` is hidden by default.

- **Login counts on the Applications page** (2026-09-09) — a `Logins (7d)` column answering
  "is anyone actually using this app" where the applications are listed, not only in the separate
  Access Usage section. Loaded by its own hook so a token without `Analytics: Read` still gets the
  table, with the column stating why it is empty. Unknown and zero stay distinct throughout: null
  renders as a dash and exports as `unavailable`, zero renders amber. The telemetry now also
  carries the raw app uuid alongside the resolved name, because the join has to match on the
  uuid — names repeat, get renamed, and are missing for an application deleted since its logins
  were recorded. On this account 8 of 24 applications saw a login in the window, and 220 logins
  belong to four applications that no longer exist.

**Incidents**
- 2026-09-09: **the Logins column shipped blank.** The loading effect guarded on
  `session.token` being truthy, but in server mode the browser holds no credential and that field
  is deliberately the empty string — so on the only deployment that matters the fetch never
  happened: no request, no error, no banner, just a column of dashes. Guard on the session
  instead. `tests/no-adhoc-auth.test.ts` now pins it, and fails if the old condition returns.
- 2026-09-07: **server mode broke for every gated route.** The Access application was recreated, which changed its AUD, so JWT verification failed audience check and the SPA fell back to asking for a token. Found while testing an unrelated route — the control route failed the same way, which ruled out the new code. Fixed by reading the live AUD from the login redirect and updating `CF_ACCESS_AUD`. See the constraints section in [README.md](README.md).

**Layout**
- `51bde1a` `min-h-0` on the shell column — a flex item defaults to `min-height: auto`, so the column grew to fit its content instead of the viewport and no section could become its own scroll container. Real bug, but not the one being chased.
- `1ddc364` `relative` on `<main>` — the actual cause of the shell scrolling. `overflow` does **not** create a containing block, so every `sr-only` label and every icon absolutely positioned inside an input anchored to the initial containing block rather than the scroller. Deep in a long page they sit past the fold: the `sr-only` span for the events-table expander landed at 1444px against a 900px viewport, stretching `<html>` until the document itself scrolled — taking the sidebar and top bar with it. Measured before/after in the running app: `html.scrollHeight` 1444 → 900, `documentScrolls` true → false, page keeps its own 2796px scroll.

**Docs / review**
- `faf1348` PROGRESS.md created
- Codebase review (2026-08-02): fixed the `engines.node` / Wrangler 4 mismatch and the missing Sync button on Access Groups; reconciled README with the shipped feature set

---

## Open issues

| # | Issue | Impact | Fix |
|---|---|---|---|
| P2 | **Deployed security headers do not match source.** Prod returns `x-frame-options: SAMEORIGIN`, `referrer-policy: same-origin` and an `x-xss-protection` header; [src/index.ts](src/index.ts) sets `DENY`, `strict-origin-when-cross-origin` and no XSS header | Cosmetic only — CSP `frame-ancestors 'none'` survives and is the authoritative control in current browsers | Something outside this repo (Access, or a zone managed-headers/transform rule) is rewriting them. Changing the Worker will not move them; check the zone's transform rules |
| P3 | **PQC Readiness counts DNS validation records as hostnames** — the one `not-ready` row on this account is `_6390ec137f3d86b975ad6f6431d343a6.nttlab.org`, an underscore-prefixed ACME/validation record | A false positive: a validation record is not a service anyone reaches, so flagging it as unprotected is noise that trains the reader to ignore the column | Exclude underscore-prefixed labels from the inventory, or classify them as a non-service record type rather than dropping them silently |
| P3 | 4 ESLint warnings: `react-hooks/incompatible-library` on TanStack `useReactTable` in [AppsTable](web/src/features/access/AppsTable.tsx) and [RulesetTable](web/src/features/waf/RulesetTable.tsx) | None — React Compiler just skips memoizing those two components | **Leave alone.** Expected for TanStack Table; not a code smell to "fix" |

### Recently resolved

- **UI/UX consistency pass across every section (2026-09-13).** An audit against every page found
  the app had two design generations, split exactly rather than randomly: nine sections framed
  themselves one way and five another, six drew a headline number one way and three another, and
  refresh lived in the top bar on three sections and inside the page on eleven under a different
  name and two different styles. Root cause was the absence of any shared style module — nine
  byte-identical `CARD` constants, five byte-identical `StatCard` components — so every new page
  copy-pasted from whichever page its author happened to open. Resolved in four commits: tokens
  (`web/src/lib/ui.ts`), shared components (`PageShell`, `StatCard`, `EmptyState`, `Tabs`), an
  accessibility sweep, and one refresh control. Three accessibility defects were fixed along the
  way — 58 uses of `text-zinc-400` with no dark-mode pair (about 2.8:1 on white, failing WCAG AA),
  17 elements whose `outline-none` left keyboard focus invisible, and two tab strips carrying half
  the ARIA pattern with no tabpanel and no arrow keys. Everything that has no runtime failure mode
  is pinned in tests.

- ~~Bound token lacked `Zone: DNS: Read` and `Zone Settings: Read`~~ — both granted; verified
  against the deployed endpoint 2026-09-12. PQC Readiness now returns **35 hostnames with zero
  errors**: 19 ready, 15 eligible, 1 not-ready, and 13 TLS hygiene findings across four zones.
  Measured post-quantum adoption is live at **33.3%** (3,838 of 11,519 measured requests) over 93
  hostnames, via the `clientTLSKeyExchangeGroup` dimension.

- ~~`useHashSyncedState` adopted URL params on mount only~~ — keyed on `route` as well, so a
  hand-edited cross-route deep link is adopted rather than overwritten. The hook gained a
  required `route` argument, which is why three call sites changed.

- ~~Worker's `CfGroup` understated what the endpoint returns~~ — widened to match the client's
  declared shape.

- ~~No git remote, and nothing enforcing the gate~~ — published at
  `bkrbybk-org/flarelens` with a GitHub Actions workflow running `npm run check` and
  `npm run lint` on every push and pull request. There is deliberately no deploy job: deployment
  needs account, zone and Access ids that this repository does not carry, and supplying them as
  Actions secrets would put the deployment's identity back into a public repo by another route.
  Deploys stay local, through the gitignored `wrangler.local.jsonc` and `npm run deploy:live`.

- ~~Bound token lacked `Workers Scripts: Read`~~ — scope added 2026-09-08 and verified live
  through Access: `/api/workers/scripts` returns 8 scripts, and the Tunnel Map now classifies 29
  rows as tunnel 15 / worker 5 / cloudflare 3 / unknown 6. The five that previously read "no route
  found" name their Worker (`certs`, `flarelens`, `worker-one`, `worker-two`,
  `worker-three`). The six still unknown match no Worker script name, so their origins are something
  else — not a scope gap.

**2026-09-08 — the P2/P3 sweep.** Everything below was closed in one pass; only the two entries
that need a change in the Cloudflare dashboard are still open above.

- ~~AI Security cached client IPs and payload ciphertext at the edge~~ — the per-zone GraphQL
  query is now **split**: aggregates (counts, series) are cached under the same token-fingerprint
  key, per-request rows are re-fetched every load and never written. `RESULT_VERSION` bumped to 6
  so entries written by the old shape are not read back. Costs a second round trip per zone on a
  cold cache. Posture and the split are documented in [README.md](README.md).
- ~~`buildMitigations` doc/code mismatch~~ — decision: severity-first ranking is correct (a block
  is a live configuration choice that can be removed; the tier is what the category costs when it
  gets through). Comment rewritten to state that; the test's NOTE calling the comment wrong is
  gone. No behaviour change.
- ~~`graphBuckets` clamped out-of-window events into the edge buckets~~ — now excluded. An event
  exactly at `end` still lands in the last bucket, since the window is inclusive of its own upper
  bound. `tests/waf-chart.test.ts` updated from pinning the bug to asserting the fix.
- ~~Connect screen did not list the newer sections' scopes~~ — `OPTIONAL_PERMISSIONS` now carries
  Cloudflare Tunnel: Read and Workers Scripts: Read, and the Analytics: Read entry names every
  section behind it. Matches the README table.
- ~~No live schema-probe readout~~ — `/api/ai-security/analyze` now returns a `schema` block
  (dataset, probe time, one row per detection field with the field name and what is lost when it
  is absent), rendered as a collapsed "Detection field coverage" panel. A KPI that is zero because
  the field does not resolve is now distinguishable from one that is zero because nothing fired.
  The other two gaps in that entry — custom absolute range and bar drill-down — had already
  shipped (`isAbsolute` windows; `injectionScores` backs the histogram drill-down).
- ~~Prompt decryption could reject a correct key~~ — the key is now accepted as base64 **or** hex
  (with or without `0x`). Every character of a 64-char hex key is legal base64, so it used to
  decode silently to 48 bytes and report "must be 32 bytes" against a perfectly good key. The
  live-payload check is still worth doing, but that failure mode is gone.
- ~~Gateway block classification unverified~~ — checked against Cloudflare's published policy
  vocabulary (2026-09-08): HTTP `action` is `allow`/`block`/`quarantine`/`isolate`/`off`, DNS
  `resolverDecision` is camelCase (`blockedOnBlockPolicy`, `allowedOnNoPolicyMatch`,
  `overrideForSafeSearch`). Only block and quarantine stop traffic and both are matched;
  `isolate` and the rewrite actions are correctly not blocks. `isBlockedVerdict` is exported and
  table-tested against that vocabulary, and the reading is written down in the README.
- ~~`waf-meta.ts` managed-`execute` and entrypoint paths uncovered~~ — four fixtures added: the
  managed ruleset indexed by its own id, child rules keyed by both id and ref, the custom
  firewall entrypoint keeping a disabled rule, and a 403 on the detail fetch costing the child
  names rather than the whole scope.
- ~~`.claude/launch.json` hardcoded the nvm `v24.16.0` path~~ — plain `npx` again.

- ~~Section snapshots leaked across accounts~~ — the cross-page WAF/Cache store was untagged module
  state that was never cleared, so after switching customers the Findings page showed the previous
  customer's rules *and* reported that section as "checked". Snapshots are now account-scoped
  (`8c2f04d`); verified end to end, and removing the guard fails two of the four new tests.

- ~~`engines.node` said `>=20.19.0` while Wrangler 4 requires `>=22`~~ — corrected to `>=22.0.0`. This mismatch already caused a real `Wrangler requires at least Node.js v22.0.0` failure; README repeated the wrong figure and is now fixed too.
- ~~Access Groups had no Sync button~~ — `showSync` now covers `access` and `groups`, the two routes that render the `/api/data` payload. WAF and Cache keep their own in-page Refresh controls.
- ~~`node_modules/` empty, `npm test`/`lint` failing with `Cannot find package 'vitest'`~~ — environment only, restored with `npm install`. Noted because the symptom looks like a code failure but isn't.

---

## Next tasks

| Task | Why | Size | Blocked by |
|---|---|---|---|
| **CI/CD** — GitHub Actions: `npm run check` on PR, deploy on merge to main | Tests and lint exist but nothing enforces them | S | Git remote + `CLOUDFLARE_API_TOKEN` repo secret (deploy-scoped, separate from a browsing token) |
| **Cache range comparison** — current vs previous equivalent window (hit-ratio and volume delta) | Turns a point-in-time number into a trend signal | M | — |
| **Component / integration tests** | Current suite covers pure logic only; UI regressions rely on manual preview checks | M | Testing-library + jsdom setup |
| **AI Gateway section** — `aiGatewayRequestsAdaptiveGroups`, `…ErrorsAdaptiveGroups`, `…CacheAdaptiveGroups`, `…SpendSessionsAdaptiveGroups` all exist on this account | Requests, cache hit rate, errors and spend. The only spend signal Cloudflare exposes directly, and Cost & Usage currently has to be priced by hand | M | — |
| **Findings covers the newer sections** | Findings folds in Access, Groups, WAF and Cache only. Everything since — AI detections, Workers error rates, Gateway blocks, Access login failures, and most pointedly the Tunnel Map's ungated hostnames — never reaches the audit view, though an ungated origin is exactly what a Findings entry is for | M | — |
| **Lazy-load the HPKE bundle** | `hpke-js` costs ~130 KB on every page load for a feature used on one tab, by one role | S | — |
| **Per-user Access and Gateway breakdowns** | `userUuid`, `email`, `deviceId` are available and deliberately unqueried | S | **A privacy decision, not a technical one** — and under a shared bound token those reads are attributable to nobody |
| **Snapshot diff / audit trail** — capture policy snapshots, diff them (and diff the newest against live) | Biggest product differentiator; answers "what changed since the last review" | L | Nothing — **designed and ready to build** |

**Snapshot storage decision (2026-08-02):** client-side **IndexedDB**, not Worker KV. KV would
put customer Access/WAF config at rest in our own account and would force every read to
live-verify the caller's token against the account — trusting the `account_id` in a request
would be a tenant-isolation bug. IndexedDB keeps the "Worker stores nothing" property intact and
ships sooner; the store sits behind an interface so a later move to KV touches one module.
Snapshots are keyed by account, capped at 20 each, with per-item and purge-all deletion, and the
diff reuses `describeRule` so rule changes read as sentences rather than JSON.

---

## Conventions

- **Commits:** Conventional Commits, imperative subject ≤50 chars, body only when the *why* isn't obvious.
- **Gate:** `npm run check` (tsc project build → tests → Vite build → wrangler dry-run) must pass before commit. `npm run lint` should show 0 errors (4 known warnings are expected — see P3 above).
- **Verification pattern:** for anything visual or layout-related, **measure, do not reason**. Two consecutive shell-scrolling fixes were shipped on plausible CSS reasoning before the cause was found by reading `html.scrollHeight` in the running app. The harness is described under Development in [README.md](README.md).
- **Layout invariants:** the shell is a fixed-height flex column and each section owns its scrolling. `<main>` must keep `relative` (containing block), `overflow-hidden` (clipping) and `min-h-0` (shrinkable), and every section renders inside [PageShell](web/src/components/PageShell.tsx), which owns the `h-full overflow-auto` that used to be copied into each page in two spellings. [tests/shell-layout.test.ts](tests/shell-layout.test.ts) pins all of it, including the one deliberate exception (Applications) — none of these fail loudly.
- **Data honesty (Cache section):** never redistribute unattributed traffic with synthetic weights, never present mock data unlabeled, and let a genuinely quiet zone show zeros. See the note at the end of [README.md](README.md).
