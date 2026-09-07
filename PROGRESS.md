# Flarelens — Progress

Status snapshot, last reviewed **2026-09-05** (second pass, against a full read of the tree) against a full read of the codebase. See [README.md](README.md) for how to run the app; this file tracks where the work stands.

**TL;DR** — Eleven sections, 457 tests green, `tsc -b` clean, 0 lint errors. **Deployed and live** at `flarelens.example.com`, behind Cloudflare Access, running in server mode: the Worker holds a read-only `CF_API_TOKEN` and Access authenticates operators, so the UI no longer asks for a token. Every section has been exercised against real account data through an Access service token.
Running version `a6bb0120`, deployed 2026-09-05 13:21 UTC.

---

## Sections

Eleven routes, grouped in the sidebar by Cloudflare product area:

| Group | Routes |
|---|---|
| Zero Trust | `#/access`, `#/groups`, `#/access-usage`, `#/tunnels`, `#/gateway` |
| Security | `#/waf`, `#/ai-security` |
| Performance | `#/cache` |
| Developer Platform | `#/workers`, `#/workers-ai`, `#/cost` |
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
| `GET /api/access/tunnels` | account | Tunnel Map — joins Access apps, their policies (reusable ones resolved), tunnel ingress rules and private routes |
| `POST /api/gateway/usage` | account | Gateway Usage (DNS resolver + Gateway HTTP) |
| `GET /api/workers/scripts` | account | Workers Analytics filter — needs `Workers Scripts: Read`, degrades if absent |
| `POST /api/workers/metrics` | account | Workers Analytics; also half of Cost & Usage |
| `POST /api/workers-ai/usage` | account | Workers AI; also half of Cost & Usage |
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
| [src/lib/workers-analytics.ts](src/lib/workers-analytics.ts) | Workers invocation metrics; script list degrades when the scope is absent |
| [src/lib/workers-ai.ts](src/lib/workers-ai.ts) | Workers AI inference metrics; folds rows split by `errorCode` |
| [src/lib/ai-sec/](src/lib/ai-sec/) | AI Security: zone fan-out, schema-capability probing, per-token edge caching, and the `buildDashboard` aggregation |
| [web/src/hooks/useTimeRange.ts](web/src/hooks/useTimeRange.ts) | Shared analytics window in minutes, hash-synced, clamped per section |
| [web/src/components/chart/ChartHover.tsx](web/src/components/chart/ChartHover.tsx) | Hover readout for every inline-SVG chart: bucket hit-testing and measured, clamped placement |
| [web/src/features/ai-security/matchedData.ts](web/src/features/ai-security/matchedData.ts) | HPKE decryption of logged prompts. Browser-only; the key never reaches the Worker or storage |
| [web/src/lib/expr.ts](web/src/lib/expr.ts) | **Wirefilter evaluator — single source.** Worker imports it for attribution (strict boolean); client imports it for the URL tester (Kleene tri-state). Pulled into the Worker build via the `web/src/lib/expr.ts` entry in `tsconfig.worker.json` |
| [web/src/lib/waf/](web/src/lib/waf/) | `aggregate` (correlation, action drift, per-rule detail), `chart` (bucketing), `format`, `constants`, `types` |
| [web/src/lib/rules.ts](web/src/lib/rules.ts) | Access rule vocabulary (`describeRule`, ~20 rule types), `resolvePolicy`, decision tones |
| [web/src/lib/findings.ts](web/src/lib/findings.ts) | Pure audit checks per source (`accessFindings`, `groupsFindings`, `wafFindings`, `cacheFindings`), plus the shared `groupUsedBy` cross-reference |
| [web/src/lib/csv.ts](web/src/lib/csv.ts) | RFC 4180 `toCsv` + `downloadCsv` (quotes fields containing commas/quotes/newlines) |
| [web/src/lib/sectionSnapshot.ts](web/src/lib/sectionSnapshot.ts) | Account-scoped cross-page store carrying the last WAF/Cache load to Findings — see the note under Frontend |

### Frontend

React 19 + Vite 8 + Tailwind 4 + TanStack Table 8. Feature-folder layout under `web/src/features/{access,waf,cache,findings}/`, shared UI in `web/src/components/` (`ProgressBar`, `table/ColumnFilterPopover`, `Icons`, `shell/{Sidebar,Topbar}`).

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
| `cf_zt_prefs` | localStorage | `PREFS_VERSION = 2`; a version bump discards saved column order/visibility so new defaults apply |
| `cf_zt_last_load_ms`, `cf_waf_last_load_ms`, `cf_cache_last_load_ms` | sessionStorage | Rolling load-duration estimates for the progress bar |

### Tests

`npm test` (Vitest, `environment: "node"` — pure logic only, no DOM).

| File | Covers |
|---|---|
| `tests/expr.test.ts` | Wirefilter evaluator: operators, functions, Kleene tri-state laws, `forAttribution` query-field rejection |
| `tests/cache-analysis.test.ts` | Last-match attribution, unattributed block, `topUrls` ranking, insights, A–F grade thresholds |
| `tests/waf-aggregate.test.ts` | Ruleset/rule correlation, action drift, zero-traffic + disabled rules, id/ref dedupe |
| `tests/waf-meta.test.ts` | Merge order survives the concurrent scope fetch |
| `tests/findings.test.ts` | Every audit check, plus the snapshot account-scoping guard |
| `tests/rules.test.ts` | `describeRule` per rule type, `resolvePolicy`, decision tones |
| `tests/csv.test.ts` | RFC 4180 escaping edge cases |

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
| P1 | **No git remote** — `git remote -v` is empty | Single copy on this machine; no backup, no PR flow, and nothing enforces `npm run check` before a deploy | `git remote add origin …`, push, then a GitHub Actions workflow running `npm run check` on PR and deploying on merge |
| P2 | **Deployed security headers do not match source.** Prod returns `x-frame-options: SAMEORIGIN`, `referrer-policy: same-origin` and an `x-xss-protection` header; [src/index.ts](src/index.ts) sets `DENY`, `strict-origin-when-cross-origin` and no XSS header | Cosmetic only — CSP `frame-ancestors 'none'` survives and is the authoritative control in current browsers | Something outside this repo (Access, or a zone managed-headers/transform rule) is rewriting them. Changing the Worker will not move them; check the zone's transform rules |
| P2 | **Bound token lacks `Workers Scripts: Read`** — re-verified 2026-09-05, `/api/workers/scripts` still returns 403 | Workers Analytics lists only workers that had traffic in the window; idle ones are missing from the filter | Add the scope in the Cloudflare dashboard, then `wrangler secret put CF_API_TOKEN`. No code change needed |
| P2 | **AI Security telemetry is cached at the edge** — [queries.ts](src/lib/ai-sec/cf/queries.ts) writes `ZoneResult` to `caches.default`, keyed by a SHA-256 fingerprint of the token, while every other section is `no-store` | Not a leak (per-token namespacing is deliberate and commented), but detection rows including client IPs and payload ciphertext persist at the edge for the TTL | Decide whether that posture is wanted here, and write the decision down either way |
| P3 | **`buildMitigations` doc/code mismatch** — its comment says a fully blocked critical signal sinks below an unblocked high one; the sort is severity-first, so it does not | Mitigation ranking may not match what the panel claims to recommend | Product decision: reword the comment, or make unmitigated volume outrank severity. `tests/ai-sec-catalog.test.ts` pins current behaviour |
| P3 | **`graphBuckets` clamps out-of-window events into the edge buckets** rather than excluding them ([chart.ts](web/src/lib/waf/chart.ts)) | An event outside the requested window is silently counted in the first or last bucket. Low impact — events are already fetched for the same window | Exclude instead of clamp; `tests/waf-chart.test.ts` pins the current behaviour and will need updating |
| P3 | **Connect screen does not list the scopes the newer sections need** — [ConnectPage](web/src/components/connect/ConnectPage.tsx) names seven optional permissions, none covering Workers Analytics, Workers AI, Gateway Usage, Access Usage or Cost & Usage | A BYOT operator sees those sections return nothing with no stated reason. Server mode is unaffected | Add them to `OPTIONAL_PERMISSIONS`, matching the table now in the README |
| P3 | **Three things the standalone `ai-sec-dashboard` had that this app does not** — a live schema-probe readout (which detection fields resolve, so a hidden KPI has a stated reason), a custom absolute time range, and bar-to-events drill-down | Operators lose "why is this KPI missing?" and per-bar navigation; the underlying data is already fetched | Schema readout is the cheap one: `getSchemaCaps` already computes it, nothing renders it. Setup knowledge is captured in [docs/ai-security-setup.md](docs/ai-security-setup.md) |
| P3 | **Prompt decryption is unverified against a real payload** — the blob parse is proven against live ciphertext, but the HPKE open path has only ever run against blobs the test suite seals itself | A format difference in the real payloads would surface as "could not decrypt" and read as a wrong key | Decrypt one live event with the zone's payload-logging private key. If Cloudflare hands the key out as hex rather than base64, `matchedData.ts` needs to accept both |
| P3 | **Gateway block classification has never seen a block** — every window queried returned `blocked: 0`, so `isBlockedVerdict` has only run against allowed traffic | A verdict string that names a block in some other form would be counted as allowed, understating the block rate | Check against a window containing a real Gateway block, or confirm the resolver/action vocabulary against Cloudflare's docs |
| P3 | **[src/lib/waf-meta.ts](src/lib/waf-meta.ts) is only lightly tested** — `cdac5e0` added merge-order coverage, but the managed-`execute` and entrypoint paths are still uncovered | A regression in the uncovered paths still mislabels rules in WAF Analytics | Extend `tests/waf-meta.test.ts` with fixtures for managed rulesets and the custom firewall entrypoint |
| P3 | 3 ESLint warnings: `react-hooks/incompatible-library` on TanStack `useReactTable` in [AppsTable](web/src/features/access/AppsTable.tsx) and [RulesetTable](web/src/features/waf/RulesetTable.tsx) | None — React Compiler just skips memoizing those two components | **Leave alone.** Expected for TanStack Table; not a code smell to "fix" |
| P3 | [.claude/launch.json](.claude/launch.json) hardcodes the nvm `v24.16.0` binary path | Breaks when Node is upgraded | Default Node is now v24, so this can revert to plain `npx` |
| P4 | `useHashSyncedState` adopts URL params on mount only. Editing the hash to a *different route* while the app is open (e.g. `#/waf?zone=A` → `#/cache?zone=B`) does not adopt the new param, because `App` never unmounts — the write-back then overwrites it | Hand-edited cross-route deep links lose their param. Fresh loads and in-app navigation are unaffected | Key the adoption on `route` as well as mount |
| P4 | Worker's `CfGroup` interface ([src/index.ts](src/index.ts)) declares only `id`/`name`, but the endpoint passes the full group object through to the client | None at runtime — TS interfaces don't strip fields — but it misleads anyone reading the Worker in isolation | Widen it to match [web/src/types.ts](web/src/types.ts) |
| P4 | Local directory still named `cf-zt-policy-dashboard/` | Cosmetic mismatch with the Flarelens name | Rename the folder |

### Recently resolved

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
| **Findings covers the newer sections** | Findings folds in Access, Groups, WAF and Cache only; AI detections, Workers error rates, Gateway blocks and Access login failures never reach the audit view | M | — |
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
- **Gate:** `npm run check` (tsc project build → tests → Vite build → wrangler dry-run) must pass before commit. `npm run lint` should show 0 errors (3 known warnings are expected — see P3 above).
- **Verification pattern:** for anything visual or layout-related, **measure, do not reason**. Two consecutive shell-scrolling fixes were shipped on plausible CSS reasoning before the cause was found by reading `html.scrollHeight` in the running app. The harness is described under Development in [README.md](README.md).
- **Layout invariants:** the shell is a fixed-height flex column and each section owns its scrolling. `<main>` must keep `relative` (containing block), `overflow-hidden` (clipping) and `min-h-0` (shrinkable), and every section root needs its own `h-full overflow-auto`. [tests/shell-layout.test.ts](tests/shell-layout.test.ts) pins all of it — none of these fail loudly.
- **Data honesty (Cache section):** never redistribute unattributed traffic with synthetic weights, never present mock data unlabeled, and let a genuinely quiet zone show zeros. See the note at the end of [README.md](README.md).
