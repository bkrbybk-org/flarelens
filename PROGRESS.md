# Flarelens — Progress

Status snapshot, last reviewed **2026-09-17** against a full read of the tree, a live probe of
the deployed API, and a UI/UX consistency pass across every section. See [README.md](README.md) for how to run the app; this file tracks where the
work stands.

**TL;DR** — Twenty-one sections, 26 API routes (including the OpenAPI document and Swagger UI), 1,127 tests green across 76 files, all type-checked, `tsc -b` clean, 0 lint errors and 0 warnings.
**Deployed and live** at `flarelens.example.com`, behind Cloudflare Access, running in server
mode: the Worker holds a read-only `CF_API_TOKEN` and Access authenticates operators, so the UI
no longer asks for a token. Every section has now been exercised against real account data
through an Access service token, AI Gateway included — its field names are resolved from the
schema at runtime rather than guessed, and returned real traffic on 2026-09-08.
Running version `9c377681`, deployed 2026-09-20 (OpenAPI document and Swagger UI; `70c69cb1` was
the same feature before the API Shield compatibility fix). The previous
version was `c9403a43`, deployed 2026-09-19 (route split, Findings everywhere, executive report,
Gateway Policies, Page & API Shield, cloudflared version check, connector metrics, dependency
upgrades). The previous versions were `4cdb50c5` (2026-09-18: WAF evaluation order),
`53721ea5` (same day, before display fixes), `5eaae590` (2026-09-17: audit fixes),
`0f744ea2` (same day: Tunnel Map connector details), `fe0829a7` (same day, same feature before a small UI fix), `6394e637` (same day: WAF Rules Review grouped by ruleset), `286c5402` (same day: DNS Records, Rate Limits & Bots, command palette, saved views,
system theme), `b18efed1` (same day, superseded by UI fixes), `3a924e84` (2026-09-16), and `fe2564bb` and `8bb29774` (2026-09-15). The three slowest routes were cut by
two-thirds in that deploy (`/api/data` 13.8s → 4.4s, `/api/access/tunnels` 12.7s → 4.0s,
`/api/pqc/report` 6.5s → 4.3s, measured in production) with responses verified unchanged.

**In `8bb29774` and `fe2564bb`:** the Zone Health section, access posture findings, a 60-second per-credential edge
cache on four configuration routes, PQC validation-record exclusion, the WAF wide-window warning, and
an allowlist test over every scoped route. Verified in production after deploy: Access gate 302,
repeat loads 4.0s → 0.05s on tunnels and PQC with `no-store` still sent to the browser, a
non-allowlisted account refused with 403, PQC down to 0 not-ready with 2 validation records excluded,
Zone Health with 0 findings and 8 certificate checks unknown pending the SSL scope. See the
2026-09-14 entry under Recently resolved.

Source lives at `bkrbybk-org/flarelens` (public). `wrangler.jsonc` carries placeholder account,
zone and Access ids; the real deployment config is the gitignored `wrangler.local.jsonc`, used by
`npm run deploy:live`. GitHub Actions runs `npm run check` and `npm run lint` on every push and
pull request; there is no deploy job, deliberately — see the note under Recently resolved.
---

## Sections

Eighteen sections, grouped in the sidebar by Cloudflare product area:

| Group | Routes |
|---|---|
| Zero Trust | `#/access`, `#/groups`, `#/access-usage`, `#/tunnels`, `#/gateway` |
| Security | `#/waf`, `#/ai-security`, `#/request`, `#/pqc`, `#/zone-health`, `#/dns`, `#/bots` |
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
| `GET /api/zones` | account | zone picker (WAF, Cache, AI Security). Edge-cached |
| `GET /api/data` | account | Access Applications, Access Groups, Findings. Policies come from the apps list payload, which embeds them; per-app policy fetches happen only for apps missing the field |
| `POST /api/waf/events` | account or zone | WAF Analytics (firewallEventsAdaptive, cursor-paginated 5×10k, deduped) |
| `GET /api/waf/rulesets` | account or zone | WAF Analytics (ruleset metadata) |
| `POST /api/cache/analyze` | zone | Cache Rules (rules + GraphQL analytics + attribution + insights) |
| `GET /api/config` | — | SPA bootstrap: credential mode, allowlisted accounts, running version. Answers `byot` rather than 401 when the Access gate does not pass, so an unauthenticated caller learns nothing about the deployment |
| `POST /api/ai-security/analyze` | account or zone | AI Security (one fan-out builds every panel) |
| `POST /api/access/usage` | account | Access Usage. Upstream caps this dataset at 1 week |
| `POST /api/request/trace` | account or zone | Request Trace — Ray ID lookup across zones, schema-driven field selection |
| `GET /api/pqc/report` | account (optional zone) | PQC Readiness — zones, their TLS settings, and every A/AAAA/CNAME record classified per TLS leg. Underscore-prefixed validation records are excluded and counted. Edge-cached |
| `GET /api/dns/records` | account (optional zone) | DNS Records — every record across the account's zones, with `origin-exposed` (public IP, DNS-only, proxiable) and `internal-address` (private IP, DNS-only) flags; a zone whose read fails is listed with its reason. Edge-cached |
| `GET /api/bots/report` | account (optional zone) | Rate Limits & Bots — `http_ratelimit` entrypoint rules (account + zones; 404 is a real zero, 403 is unknown) and per-zone `bot_management` settings with inferred plan tier and findings. Edge-cached |
| `GET /api/zone-health/report` | account (optional zone) | Zone Health — certificate expiry across edge packs, custom certificates and Origin CA (each degrading on its own permission), plus DNS hygiene: dangling tunnel and external CNAMEs, DNS-only origins, duplicates. Edge-cached |
| `GET /api/access/tunnels` | account | Tunnel Map — joins Access apps, their policies (reusable ones resolved), tunnel ingress rules and private routes. Tunnel-side reads start without waiting for the apps. Edge-cached |
| `POST /api/gateway/usage` | account | Gateway Usage (DNS resolver + Gateway HTTP) |
| `GET /api/workers/scripts` | account | Workers Analytics filter — needs `Workers Scripts: Read`, degrades if absent |
| `POST /api/workers/metrics` | account | Workers Analytics; also half of Cost & Usage |
| `POST /api/workers-ai/usage` | account | Workers AI; also half of Cost & Usage |
| `POST /api/ai-gateway/usage` | account | AI Gateway (proxy requests, tokens, errors, cache, spend). Field names resolved from the live schema — see [src/lib/ai-gateway.ts](src/lib/ai-gateway.ts) |
| `app.all("*")` | — | static asset fallback |

All `/api/*` responses carry `Cache-Control: no-store`. Invalid IDs → 400, missing/bad token →

**Edge cache.** `/api/zones`, `/api/access/tunnels`, `/api/pqc/report` and `/api/zone-health/report` are held in
the Worker's Cache API for 60 seconds ([src/lib/edge-cache.ts](src/lib/edge-cache.ts)). The key is the auth mode, a
SHA-256 fingerprint of the *resolved* credential, the path and only the already-validated params, and it is
consulted only after auth, validation and the allowlist have all passed. Only `success: true` 200s are stored.
The top bar's Sync sends `X-Flarelens-Fresh: 1`, which bypasses and refreshes the entry; a mount or account
switch takes the cached read. Pages served from cache say so with the clock time it was cached. Browser
responses stay `no-store`.
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
| [src/lib/zone-health.ts](src/lib/zone-health.ts) | Certificate expiry (managed packs held to 7 days since they should renew themselves, custom 14/30, Origin CA 30; a pack that never issued is a finding) and DNS hygiene. Dangling means NXDOMAIN from DNS-over-HTTPS and nothing else; any other outcome is unknown. Tunnel CNAMEs are checked against the account tunnel list, domain-validation targets are skipped and counted, lookups capped at 200 per report |
| [src/lib/edge-cache.ts](src/lib/edge-cache.ts) | `cacheKey` and `withEdgeCache`: the tenant-isolated 60s cache described under API routes. A malformed entry is a miss, a cache failure falls through to a live read |
| [web/src/lib/edge-cache-caption.ts](web/src/lib/edge-cache-caption.ts) | The one sentence that tells a reader their data came from cache. States the clock time it was cached, not an age — an age is computed once at render and is untrue a few minutes later |
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
| [web/src/features/tunnels/sankey.ts](web/src/features/tunnels/sankey.ts) | Pure layout for the Tunnel Map's flow diagram (Access → tunnel → origin): node stacking, ribbon geometry, and the tone rules — a node reads as the worst thing inside it, so "No tunnel" turns amber when it holds an unidentified origin |
| [web/src/features/tunnels/TunnelSankey.tsx](web/src/features/tunnels/TunnelSankey.tsx) | Renders that layout as inline SVG; a tunnel node is a filter for the table below |
| [web/src/components/PageShell.tsx](web/src/components/PageShell.tsx) | The frame every section renders inside: `h-full overflow-auto` + `space-y-4 p-4 md:p-6`. Applications is the deliberate exception — its table owns the scrolling |
| [web/src/components/StatCard.tsx](web/src/components/StatCard.tsx) | `StatCard` (label over value, optional icon/hint/tone; formats numbers itself) and `StatGrid` (two columns on a phone, `cols` at `lg`) |
| [web/src/components/EmptyState.tsx](web/src/components/EmptyState.tsx) | `EmptyState` (page), `EmptyNote` (inside a card), `EmptyRow` (inside a table). `loading` is a separate state from empty |
| [web/src/components/Tabs.tsx](web/src/components/Tabs.tsx) | The full ARIA tabs contract: `aria-controls`/`aria-labelledby` both ways, roving tabindex, Left/Right/Home/End with wrapping |
| [web/src/components/LoadingVeil.tsx](web/src/components/LoadingVeil.tsx) | The loading treatment: progress bar with a time caption above content dimmed to 50% with `aria-busy`. Dimmed, not disabled — the stale data stays readable. Used by `PageShell` and by Applications |
| [web/src/components/ErrorBoundary.tsx](web/src/components/ErrorBoundary.tsx) | Per-section render-failure boundary; `formatErrorDetails` is unit-tested |
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
| [useEstimatedProgress](web/src/hooks/useEstimatedProgress.ts) | Progress estimated from this section's last real load duration. Exposes `etaMs`, `elapsedMs` and `measured`: a countdown is shown only when the estimate was measured and still ahead of the clock, otherwise elapsed time |
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
| `cf_zt_last_load_ms`, `cf_<section>_last_load_ms` (14 keys, one per data hook) | sessionStorage | Rolling load-duration estimates, blended 50/50 with the previous value on each successful load; a failed load records nothing |

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
| `tests/ai-gateway.test.ts` | AI Gateway route: series/totals fold, rate arithmetic (never divides by zero), per-dataset degradation when a field does not resolve, validation, auth, `no-store`, 502 on load-bearing failure, and the same "no per-user dimension" privacy assertion as the other aggregate-only sections |
| `tests/data-fanout.test.ts` | `/api/data` and the tunnel map use embedded app policies, fetch only apps missing the field, and issue the three tunnel-side reads concurrently (checked to fail against a serialised build) |
| `tests/zone-health.test.ts`, `tests/components/ZoneHealthPage.test.tsx` | Certificate thresholds by source, 9109/403 as not-checked, unissued packs, dangling tunnel vs live, NXDOMAIN vs every other DoH outcome, validation targets skipped, the lookup cap, private addresses (incl. IPv4-mapped IPv6), duplicates, the tunnel list fetched alongside zone reads; and a page that never calls DNS clean without saying what went unchecked |
| `tests/edge-cache.test.ts` | Key determinism and namespacing, BYOT tokens never sharing an entry, errors never cached, Fresh bypass and repair, byte-identical HITs, cache failure falling through |
| `tests/routes-auth.test.ts` (allowlist block) | Every one of the 15 account/zone-scoped routes refuses a non-allowlisted scope in server mode with exactly 403, no upstream call and no cache lookup or write, plus a control proving the allowlisted request passes the gate. Verified against 19 mutants |
| `tests/waf-wide-window.test.ts`, `tests/app-server-mode-accounts.test.ts` | The WAF warning beyond 7 days; server mode reusing `config.accounts` instead of refetching accounts |
| `tests/tsconfig-references.test.ts` | Root `tsconfig.json` keeps referencing both test projects, so tests cannot silently drop out of type-checking again |
| `tests/tunnel-sankey.test.ts` | The flow diagram's arithmetic, which fails silently: every column sums to the row count, each node's ribbons sum to the node, no band overflows the node it leaves, no two nodes in a column overlap, and an unidentified origin never folds into the others |
| `tests/components/progress.test.tsx` | The honesty rules for the time caption (countdown only when measured and ahead; elapsed otherwise; never "0s"), the bar outside the dimmed region, content left interactive |
| `tests/components/estimated-progress.test.tsx` | No estimate before a first timed load, recorded duration used next time, blended rather than replaced, nothing recorded from a failure |
| `tests/system-routes.test.ts` | Every core route through the real app against one mocked Cloudflare: shapes, validation, error mapping, headers, `no-store` |
| `tests/compat-upstream-shapes.test.ts` | Pagination, partial-scope tokens (including per-app policy failures), malformed payloads, Workers-only globals |
| `tests/access-tunnels.test.ts` | The hostname → app → tunnel → origin chain, origin kinds, both gap types, degradation without scopes |
| `tests/access-usage.test.ts`, `tests/gateway-usage.test.ts`, `tests/workers-analytics.test.ts`, `tests/workers-ai.test.ts` | Each telemetry route: aggregation, validation, presentation helpers; Gateway also its verdict vocabulary and the no-per-user-field privacy assertion |
| `tests/request-trace.test.ts` | Ray ID normalisation, field-ceiling and per-zone entitlement retries, the route |
| `tests/integration-ai-security.test.ts` | AI route wired to the real library and Cache API with only the network mocked, including cache-key tenant isolation |
| `tests/ai-sec-{catalog,dashboard,params,transform}.test.ts` | AI Security domain layer: labels and mitigations, `buildDashboard`, window/bucket parameters, detection predicates |
| `tests/auth.test.ts`, `tests/routes-auth.test.ts`, `tests/no-adhoc-auth.test.ts` | Credential resolution, every route gated in both modes, and the source guard keeping auth in one module (including the server-mode empty-token trap) |
| `tests/security-boundaries.test.ts`, `tests/matched-data.test.ts` | Bound token never leaves the Worker, allowlist evasion, input handling; prompt-decryption key never stored, sent or exported |
| `tests/shell-layout.test.ts` | The flex height chain, PageShell as the only scroll container, and Applications as the deliberate exception |
| `tests/waf-chart.test.ts`, `tests/chart-hover.test.ts`, `tests/hash-params.test.ts` | WAF bucketing, chart hover hit-testing and placement, deep-link params including route-keyed adoption |
| `tests/apps-export.test.ts`, `tests/error-boundary.test.ts` | CSV exports rendered text rather than raw JSON; the error-boundary formatter |
| `tests/e2e-live.test.ts` | The deployed Worker through real Access. **Opt-in** (`FLARELENS_E2E=1`), spends real API quota |

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
| P2 | **Deployed security headers do not match source.** Prod returns `x-frame-options: SAMEORIGIN`, `referrer-policy: same-origin` and an `x-xss-protection` header; [src/index.ts](src/index.ts) sets `DENY`, `strict-origin-when-cross-origin` and no XSS header | Cosmetic only — CSP `frame-ancestors 'none'` survives and is the authoritative control in current browsers | Something outside this repo (Access, or a zone managed-headers/transform rule) is rewriting them. Changing the Worker will not move them; check the zone's transform rules. **Re-confirmed 2026-09-16** after four further deploys — the deployed values have not moved, which rules out a stale build |
| P3 | **Bound token lacks Zone: Bot Management: Read** | Rate Limits & Bots reports every zone's bot settings as *not checked* (4 unknown), so the bot findings never fire and the plan-tier inference is untested against a real response | Add the scope to `CF_API_TOKEN`; then check the tier and the "protection off" reading against live data — both are inferred from documented fields, not a confirmed mapping |
| P3 | **Bound token lacks SSL and Certificates: Read** | Zone Health reports edge and custom certificates as *not checked* on every zone (8 unknown checks), so certificate expiry is currently unmonitored | Add the scope to `CF_API_TOKEN`; no code change — the section starts grading on the next load |
| P3 | **Bound token lacks API Gateway: Read** | Page & API Shield reports API Shield as not checked on every zone | Add the scope; then verify the API Shield half against live data — it is built from Cloudflare's API docs only |
| P3 | **`/api/waf/rulesets` takes ~20s uncached** | WAF Analytics' first load is slow; it fetches every ruleset's detail per zone and has no edge cache | Put it behind the same 60s per-credential edge cache as the other configuration routes |
| P3 | **Connector metrics not verified live** | CPU/memory in the tunnel drawer is tested against mocks only | Publish one connector's metrics endpoint behind Access and set the `TUNNEL_METRICS` secret (README has the setup) |

### Recently resolved

- **The API documents itself (2026-09-20, `70c69cb1`).** `GET /api/openapi.json` serves an
  OpenAPI 3.1 document for all 24 endpoints — both credential modes, the success/error envelopes,
  the id parameters, the edge-cache headers and `X-Flarelens-Fresh`, and each route's real error
  statuses — and `GET /docs` serves Swagger UI for it. Both sit behind the same auth as every
  other route, so Access already gates them; `/health` is the one path documented as unsecured.
  Swagger UI is self-hosted (the CSP allows scripts from `'self'` only, so a CDN copy could not
  run) and copied out of `swagger-ui-dist` at build time rather than committed. `/docs` is the
  only path that relaxes the CSP, and only `style-src`, for the inline styles Swagger UI injects.
  A drift test compares the document against Hono's own route table in both directions, so a new
  route cannot ship undocumented — checked by deleting a path and watching it fail.
  *Found in review:* the first build put the Swagger bootstrap in an inline `<script>`, which the
  page's own `script-src 'self'` blocked — the page rendered blank while every header test passed.
  The bootstrap is now `/docs/init.js`, and a test rejects any inline script in that page.
  *Also:* the guard keeping credential reads inside `src/lib/auth.ts` exempts the document module
  for the header *name* it has to print, but the test now also asserts that module never touches a
  request at all.
  *Follow-up the same day:* uploading the document to Cloudflare API Shield failed with
  `failed to construct endpoint URLs: server URL: host not present` — the document declared a
  relative server (`/`). It now names the absolute origin of the request that asked for it. The
  same check turned up a second blocker: API Shield relies on **OAS 3.0 and rejects 3.1**, which
  the document declared. It is now 3.0.3, with fixed values written as one-value `enum`s instead
  of `const`, and tests pin the version, the absolute server, the absence of 3.1-only constructs
  and external `$ref`s.

- **Ten items in one pass (2026-09-19, `c9403a43`).** Built by Sonnet agents in separate worktrees:
  the refactor first on its own, then five in parallel. Each diff was reviewed, merged,
  checked in the gate and verified against the live account.
  - *Route split (#16):* `src/index.ts` 1,624 → 65 lines. The routes moved into 16 files under
    `src/routes/`, with shared helpers in `src/http.ts` and shared types in `src/env.ts` and
    `src/cf-types.ts`. All 21 routes are unchanged and registered in the same order. *One REST
    client (#17):* `fetchCloudflare`/`fetchCloudflareAll` moved into `src/lib/cf-rest.ts`.
    *DNS URL key (#18):* the DNS page's zone filter now uses its own key, `dns_zone`.
  - *Upgrades (#19):* TanStack Table 9, which also removed all 5 known lint warnings, and Vitest 5.
    **TypeScript 7 was skipped:** it is the Go-native compiler, and `typescript-eslint` 8.70
    (latest) requires TypeScript `<6.1.0`.
  - *Findings covers every section (#1):* Tunnels, Zone Health, PQC, DNS, Rate Limits & Bots, WAF
    evaluation order, Gateway Policies and Page & API Shield. Each source shows whether it was
    checked (with a count), is loading, could not be checked (with the reason), or has not been
    opened. Live: 11 high / 35 medium / 69 low. *Executive report (#5):* a self-contained HTML
    download; every interpolated value is escaped.
  - *cloudflared version check (#8):* latest release from GitHub, cached 1h — the app's first call
    to a service outside Cloudflare. Live: **one connector runs 2025.8.1, 13 months behind**; the
    rest run 2026.6.x, about 3 months behind 2026.9.1. *Connector metrics (#7):* the endpoints to
    read come from the `TUNNEL_METRICS` secret, never from a request. Before fetching, the tunnel
    must belong to the account. The fetch uses https only, gives up after 5s, treats a redirect as
    an error, caps the body at 2 MB, and returns only parsed numbers. **Not verified live**: no
    metrics endpoint is published yet (the route correctly answers 404 "not configured").
  - *Gateway Policies (#11):* the account's 33 Gateway rules in enforcement order (DNS resolver →
    DNS → network → HTTP, by precedence), following Cloudflare's order-of-enforcement docs. 14
    findings, including 2 HTTP allow rules with no identity condition and 1 that passes untrusted
    certificates through.
  - *Page & API Shield (#12):* Page Shield is on for 1 of 4 zones (7 scripts, 4 connections, none
    flagged malicious). **API Shield is not checked on any zone:** the token lacks "API Gateway:
    Read", so the page says so instead of showing zeros. It is built from the API docs and has
    not been verified live.
  - *Found in review and fixed:* **a 403 logged the operator out.** Every loader treated 403 as a
    dead session, and routes pass Cloudflare's 403 through, so opening a section the token could
    not read disconnected the user. On Findings, any one of its sources could do it. Now only a
    401 ends the session (`isSessionError`), and a test requires every session-ending call to be
    inside that check; the test fails when a loader is changed back. The Cache loader already
    ended the session on 401 only, which is how the inconsistency showed. Also rejected
    `localhost.` / `*.localhost` as metrics targets.
  - *Noticed, not fixed:* an uncached `/api/waf/rulesets` takes about 20s on this account. It
    fetches every ruleset's detail for every zone and is not edge-cached.

- **WAF evaluation order (2026-09-18, `4cdb50c5`).** Rules Review can now list rules in the
  order Cloudflare evaluates them: custom rules → rate limiting → managed rules; the account
  entrypoint before each zone's; each list top-down; an `execute` rule expands into the ruleset
  it runs. To support this, the WAF metadata now records each rule's position, the ruleset an
  `execute` rule runs, and where each ruleset is deployed (live: all 2,322 rules have a position,
  14 deployments). Live findings: **one zone disables its Cloudflare Managed Ruleset
  deployment, so 852 managed rules never run in that zone**. Cloudflare Exposed Credentials Check
  and Managed Free are deployed nowhere. No rule on the account blocks every request.
  Fixed on the way: account custom rulesets were labelled "Managed". The entry recorded for a
  ruleset from the rule that deploys it assumed managed, and overwrote the ruleset's own entry
  whenever the deploying rule was read later (7 rulesets on this account). The real entry now
  always takes precedence, in either read order. The first deploy (`53721ea5`) had two
  misleading displays, fixed before release: "852 rules never run" gave no zone, and each
  deployment row showed its ruleset's events summed across every zone, even when that zone had
  the deployment disabled.
  Known limits, stated on the page: managed-rule overrides are not applied; "never runs" is only
  claimed behind a disabled deployment or a rule whose expression is literally `true`.

- **Audit pass: bugs, security, debt (2026-09-17, `5eaae590`).** Fixes:
  - *CSV formula injection.* Exports include text other people control: WAF request paths,
    DNS TXT content, application names. A cell starting `=`, `+`, `-`, `@`, tab or CR now gets a
    leading apostrophe, so spreadsheets show it as text instead of running it as a formula.
    Numbers are not changed.
  - *CSV encoding.* Downloads now start with a UTF-8 byte-order mark. Without it, Excel shows
    Thai application names as unreadable characters.
  - *Unchecked ids in upstream paths.* `/api/zones` and `/api/data` put `account_id` into the
    Cloudflare URL without checking it. The allowlist blocked this in server mode, but a caller
    using their own token could send a path-shaped value. Both routes now require a 32-hex id,
    like every other route. List ids taken from policy rules must be UUIDs before they go into a
    path. The allowlist test now accepts either refusal code (400 or 403); it still requires
    that nothing reaches Cloudflare.
  - *Blocked browser storage crashed the app.* When a browser blocks site data, simply touching
    `sessionStorage` throws, and the session, prefs and progress hooks did so while the app was
    starting. They now go through `web/src/lib/storage.ts`, which never throws. The new test was
    checked by putting one unguarded call back: the test failed.
  - *Hono advisories.* 7 moderate advisories, fixed by moving to 4.13.8 (`package.json` now
    requires at least that version). Other dependencies were updated within their existing
    version ranges. `npm audit` reports 0.
  - *Duplicated Cloudflare client code.* `mapWithConcurrency` had five identical copies and the
    paginated list reader had four. Both now live in `src/lib/cf-rest.ts` (−157 lines).
  - Checked and left alone: the `zone` value kept in the URL is shared by App and the DNS page.
    App does nothing with it on `#/dns`, so DNS deep links work, but the arrangement breaks
    easily if either side changes.

- **Tunnel Map connector details (2026-09-17, `0f744ea2`).** Clicking a tunnel opens a detail
  panel: its connectors (cloudflared version, architecture, start time, features) and each
  connector's edge connections (data center, when opened, source IP, reconnecting). Also its
  hostnames and private routes. Connectors come from `GET /cfd_tunnel/{id}/connections`. Cloudflare
  deprecated the `connections` field on the tunnel list on 2026-07-09, so the app now reads that
  field only when the connections call fails. Live: 8 tunnels,
  no read errors. One tunnel runs two connectors on different versions (2026.6.0 / 2026.6.1),
  five healthy tunnels run a **single connector with no redundancy**, two are down with none.
  **CPU and memory are not available**: Cloudflare's API does not report them, and `cloudflared`
  serves them only on its local Prometheus endpoint, which the Worker cannot reach. The page says
  so. Cost: 8 more upstream calls, so an uncached `/api/access/tunnels` went from about 4.0s to 5.3s.

- **WAF Rules Review grouped by ruleset (2026-09-17, `6394e637`).** A flat list of 1,208 rules,
  25 per page, did not show which ruleset a rule belongs to until each card was read. Rules are now
  grouped by ruleset id (collapsible, busiest first, 10 rules shown before "Show all"). On the
  live account that is 28 rulesets. Grouping by name would have merged rulesets from different zones: five
  zone custom rulesets are all called `default`, so zone custom groups now show their zone.
  Managed groups do not: one managed ruleset id is deployed to many zones, and the metadata keeps
  only one of them. 59 events on 3 rules not in the metadata are grouped last as *Unattributed*.

- **Five features in one pass (2026-09-17, `286c5402`).** Implemented by three Sonnet agents in
  separate worktrees, then reviewed, merged, fixed and verified against the live account:
  - *DNS Records (`#/dns`)* — 46 records across 4 zones, no zone errors. Review caught a private
    address graded as an exposed origin; it is now `internal-address`, matching Zone Health.
  - *Rate Limits & Bots (`#/bots`)* — 7 rules on one zone, three zones with none, account
    entrypoint 404 read as a real zero. Review caught three misreadings of bot settings: "Block AI
    bots" (offered on every plan) marking a zone Enterprise, Super Bot Fight Mode set to `allow`
    counted as on, and an Enterprise zone without `fight_mode` flagged unprotected. The live UI
    showed two more: "Not checked" printed twice, and a "0 on" headline when all four zones were
    unreadable, which now says "Unknown".
  - *Command palette (⌘K)*, *saved views* (per account, localStorage) and a *system* theme mode,
    with `web/public/theme-init.js` setting the theme before first paint (the CSP blocks inline
    scripts). The sidebar and the palette read one nav list (`web/src/components/shell/nav.ts`),
    and a test checks that every route appears in it exactly once.
  - *Process note:* two of the three agents stalled on a 600s watchdog — one had already
    committed, the other was resumed and finished. The vite dev proxy against production needs
    `secure: false` from this network: TLS inspection breaks Node's certificate chain, while curl
    uses the system trust store.

- **Tunnel Map gained a flow diagram (2026-09-16, `3a924e84`).** The table says what each
  destination is; it cannot say that most of the estate is gated yet reaches no tunnel. Three
  columns — Access → tunnel → origin — each ribbon one destination tall. An earlier four-column
  draft opened with application type, but "no Access app" and "ungated" are the same rows under two
  names, so that column was dropped. Drawn against the live account before shipping, which caught
  three things tests could not: "reaches a tunnel" was rendered in the Cloudflare brand orange and
  read as a warning next to the red exposure bands (now emerald), long tunnel names ran into the
  middle of the drawing (now right-aligned outside it), and the "No tunnel" node was grey while
  carrying all eight unidentified origins (now amber, matching its own ribbons).

- ~~`tests/` was not type-checked~~ (2026-09-15, #9). `tsc -b` now builds two more projects —
  `tests/tsconfig.json` (Workers types + Node, no DOM) and `tests/components/tsconfig.json` (DOM +
  JSX) — referencing the source projects they import, so tests are checked against the real
  declarations. One real stale fixture surfaced: `GroupsPage.test.tsx` built `RuleContext` as
  `{ idpNames, groupNames }` lookup maps while the real type takes resolver functions. Verified the
  check bites: a planted wrong type in a node test, a planted wrong type in a component test, and
  that exact stale fixture each fail `tsc -b`. `tests/tsconfig-references.test.ts` fails if the
  root tsconfig stops referencing either project; a shared typed `ctx()` in
  `tests/helpers/execution-context.ts` replaced nine ad-hoc mocks.

- **Feature batch #5–#7, #10–#13 (2026-09-14, deployed as `8bb29774`).** Assessed first, implemented by
  Sonnet agents in worktrees, then reviewed, corrected and verified against the live account:
  - *Access posture findings:* long sessions, session cookies without `HttpOnly`, CORS wildcards,
    broad allows with no second condition. On live data 23 of 29 apps lack `HttpOnly`; before
    shipping a finding that fires that often, the API field was checked against the real
    `CF_Authorization` Set-Cookie header, which indeed carries no `HttpOnly` flag.
  - *Zone Health (new section):* see the modules table. The live run caught a false positive the
    tests could not — Google's `dv.googlehosted.com` verification target is NXDOMAIN by design and
    was reported as a high takeover risk; validation targets are now skipped and counted. Review
    also added unissued certificate packs as findings and stopped the DNS card calling a partly
    unread account "clean".
  - *Edge cache:* see API routes. Review replaced an age caption that went stale on screen with a
    clock time, and made malformed entries a miss.
  - *Allowlist coverage:* deleting the scope check from `/api/pqc/report` passed the entire suite —
    only 5 of 15 scoped routes had it pinned. All 15 now do; 19 mutants killed.
  - *Also:* PQC excludes underscore-prefixed validation records (the lone "not ready" row was an
    ACME record); WAF warns beyond 7 days; server mode no longer refetches accounts at bootstrap.
  - *Deploy note:* the first attempt failed with `Authentication error [code: 10000]` because the
    deploy shell had sourced `.dev.vars`, and wrangler accepts `CF_API_TOKEN` as a legacy alias for
    its own token — so it tried to deploy with the app's read-only token. Deploy from a shell
    without `.dev.vars` loaded.
  - *Process note:* worktree isolation branched agents from `origin/main` (10 commits stale), and a
    `node_modules` symlink got committed and overwrote main's install on merge. Both caught before
    anything was pushed; history rewritten locally, `.gitignore` now matches symlinks.

- **API latency cut by two-thirds (2026-09-12).** `/api/data` and `/api/access/tunnels` each
  fetched `/access/apps/{app}/policies` for every application — 29 round trips at five at a time,
  about six seconds — although `GET /access/apps` already embeds identical policy objects (verified
  field by field for all 29 apps). They now read the embedded policies and fetch individually only
  for apps whose `policies` field is absent (`private_ip` today), so `policies_error` still means
  what it says. The tunnel map's configuration, route and Worker-domain reads now run together,
  and PQC's adoption probe runs alongside the readiness report. Production, before → after:
  `/api/data` 13.8s → 4.4s, tunnels 12.7s → 4.0s, PQC 6.5s → 4.3s. Responses compared before and
  after on live data: tunnels byte-identical, data identical apart from Cloudflare's own
  nondeterministic array order, PQC identical apart from adoption counts in a window that slid
  two minutes.

- **Loading states say how long and show what is stale (2026-09-12).** `useEstimatedProgress`
  computed an ETA nothing rendered. The bar now carries a caption — a countdown only when the
  estimate came from a measured load and is still ahead of the clock, elapsed time otherwise,
  and "taking longer than usual" once a load outruns its estimate — and the content under it dims
  with `aria-busy` while stale. Shared through `LoadingVeil`.

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
- ~~Access Groups had no Sync button~~ — `showSync` now covers `access` and `groups`, the two routes that render the `/api/data` payload. *(Superseded 2026-09-13: every section now reloads from the top bar's Sync via `useSectionRefresh`; no section has an in-page Refresh.)*
- ~~`node_modules/` empty, `npm test`/`lint` failing with `Cannot find package 'vitest'`~~ — environment only, restored with `npm install`. Noted because the symptom looks like a code failure but isn't.

---

## Next tasks

| Task | Why | Size | Blocked by |
|---|---|---|---|
| **CD** — deploy from GitHub Actions (CI already runs `check` + `lint`) | Deploys are local only | S | A way to supply account/zone/Access ids without putting them in the public repo — the reason there is no deploy job today |
| **Cache range comparison** — current vs previous equivalent window (hit-ratio and volume delta) | Turns a point-in-time number into a trend signal | M | — |
| **Findings covers the newer sections** | Findings folds in Access, Groups, WAF and Cache only. Everything since — AI detections, Workers error rates, Gateway blocks, Access login failures, and most pointedly the Tunnel Map's ungated hostnames, Zone Health's dangling CNAMEs and expiring certificates — never reaches the audit view, though an ungated origin is exactly what a Findings entry is for | M | — |
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
- **Gate:** `npm run check` (tsc project build → tests → Vite build → wrangler dry-run) must pass before commit. `npm run lint` should show 0 errors and 0 warnings (the 5 TanStack warnings went away with Table 9).
- **Verification pattern:** for anything visual or layout-related, **measure, do not reason**. Two consecutive shell-scrolling fixes were shipped on plausible CSS reasoning before the cause was found by reading `html.scrollHeight` in the running app. The harness is described under Development in [README.md](README.md).
- **Layout invariants:** the shell is a fixed-height flex column and each section owns its scrolling. `<main>` must keep `relative` (containing block), `overflow-hidden` (clipping) and `min-h-0` (shrinkable), and every section renders inside [PageShell](web/src/components/PageShell.tsx), which owns the `h-full overflow-auto` that used to be copied into each page in two spellings. [tests/shell-layout.test.ts](tests/shell-layout.test.ts) pins all of it, including the one deliberate exception (Applications) — none of these fail loudly.
- **Data honesty (Cache section):** never redistribute unattributed traffic with synthetic weights, never present mock data unlabeled, and let a genuinely quiet zone show zeros. See the note at the end of [README.md](README.md).
