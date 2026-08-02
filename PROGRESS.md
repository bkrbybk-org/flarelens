# Flarelens — Progress

Status snapshot as of **`89b4597`** (2026-07-13). See [README.md](README.md) for how to run the app; this file tracks where the work stands.

**TL;DR** — Feature-complete for the three planned sections, 64 unit tests green, `npm run check` clean. **Not yet deployed:** `flarelens.example.com` is configured but `wrangler deploy` has never run, and the app has never been exercised against a real API token.

---

## Architecture

### Request flow

```
browser ──► Worker (Hono, src/index.ts) ──► api.cloudflare.com
              │                              (REST + GraphQL)
              └─► ASSETS binding ──► web/dist (Vite build)
```

`assets.run_worker_first: true` means the Worker sees every request first, so security headers and CSP land on the HTML document too — not just API responses. The Worker holds no credentials: the browser sends the user's token per request as `Authorization: Bearer`, and the Worker forwards it upstream within the same invocation. Nothing is stored server-side (no KV/D1/secrets).

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
| `app.all("*")` | — | static asset fallback |

All `/api/*` responses carry `Cache-Control: no-store`. Invalid IDs → 400, missing/bad token → 401/403, upstream failure → 502.

### Modules

| Path | Role |
|---|---|
| [src/lib/waf-meta.ts](src/lib/waf-meta.ts) | Flattens rulesets (account + zone scopes, managed `execute` targets, custom firewall entrypoint) into a rule-id/ref keyed map |
| [src/lib/cache-analysis.ts](src/lib/cache-analysis.ts) | Cache GraphQL queries, last-match attribution, insights, A–F health grade, labeled mock fallback |
| [src/lib/cache-cf-types.ts](src/lib/cache-cf-types.ts) | Cloudflare REST/GraphQL response shapes for the cache path |
| [web/src/lib/expr.ts](web/src/lib/expr.ts) | **Wirefilter evaluator — single source.** Worker imports it for attribution (strict boolean); client imports it for the URL tester (Kleene tri-state). Pulled into the Worker build via the `web/src/lib/expr.ts` entry in `tsconfig.worker.json` |
| [web/src/lib/waf/](web/src/lib/waf/) | `aggregate` (correlation, action drift, per-rule detail), `chart` (bucketing), `format`, `constants`, `types` |
| [web/src/lib/rules.ts](web/src/lib/rules.ts) | Access rule vocabulary (`describeRule`, ~20 rule types), `resolvePolicy`, decision tones |

### Frontend

React 19 + Vite 8 + Tailwind 4 + TanStack Table 8. Feature-folder layout under `web/src/features/{access,waf,cache}/`, shared UI in `web/src/components/` (`ProgressBar`, `table/ColumnFilterPopover`, `Icons`, `shell/{Sidebar,Topbar}`).

Routing is hash-based with no router dependency — [useRoute.ts](web/src/hooks/useRoute.ts) parses the path segment, [useHashParams.ts](web/src/hooks/useHashParams.ts) syncs query params. Four sections: `#/access`, `#/groups`, `#/waf`, `#/cache`. Deep links like `#/waf?zone=…&lookback=1440&tab=rules` win over saved prefs on load, then mirror state back via `replaceState`.

**Hooks**

| Hook | Responsibility |
|---|---|
| [useSession](web/src/hooks/useSession.ts) | Token + account in sessionStorage |
| [usePrefs](web/src/hooks/usePrefs.ts) | Theme, density, columns, page size, zone selections (localStorage, versioned) |
| [useRoute](web/src/hooks/useRoute.ts) / [useHashParams](web/src/hooks/useHashParams.ts) | Hash routing + deep-linkable state |
| [useZones](web/src/hooks/useZones.ts) | Lazy zone list, cached per account |
| [useZeroTrustData](web/src/hooks/useZeroTrustData.ts) / [useWafData](web/src/features/waf/useWafData.ts) / [useCacheData](web/src/features/cache/useCacheData.ts) | Per-section fetch + state |
| [useEstimatedProgress](web/src/hooks/useEstimatedProgress.ts) | Progress bar estimated from the last real load duration |

> **Hook contract:** the three data hooks keep `load` referentially stable (callbacks held in refs, progress fns destructured) so page effects can list it in their dependency arrays. Don't reintroduce `onAuthError` into a `useCallback` dep list — it re-fires the effect on every parent render.

### Client storage

| Key | Store | Notes |
|---|---|---|
| `cf_api_token`, `cf_account_id`, `cf_account_name` | sessionStorage | Cleared on tab close; never persisted to disk |
| `cf_zt_prefs` | localStorage | `PREFS_VERSION = 2`; a version bump discards saved column order/visibility so new defaults apply |
| `cf_zt_last_load_ms`, `cf_waf_last_load_ms`, `cf_cache_last_load_ms` | sessionStorage | Rolling load-duration estimates for the progress bar |

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

---

## Open issues

| # | Issue | Impact | Fix |
|---|---|---|---|
| P1 | **Never deployed.** `npm run deploy` has not been run, so `flarelens.example.com` has no DNS record or edge cert yet | App is not reachable by anyone | Run `npm run deploy`. Requires the `example.com` zone to live in the target account |
| P1 | **No `account_id` in [wrangler.jsonc](wrangler.jsonc)** and the token sees 2 accounts | `wrangler deploy` will prompt interactively, and fails outright in CI | Add `"account_id": "<id>"` — pick the account holding `example.com` |
| P2 | **No git remote** — `git remote -v` is empty | Single copy on this machine; no backup, no PR flow, blocks CI/CD | `git remote add origin …` + push |
| P2 | **Never run against a real token.** All verification used mocked `window.fetch` fixtures | Real-world API shape drift would go unnoticed | Smoke test each section with a scoped token |
| P3 | Old `cf-zt-policy-dashboard` Worker likely still deployed | Stale duplicate serving old code | `npx wrangler delete --name cf-zt-policy-dashboard` |
| P3 | 2 ESLint warnings: `react-hooks/incompatible-library` on TanStack `useReactTable` in [AppsTable](web/src/features/access/AppsTable.tsx) and [RulesetTable](web/src/features/waf/RulesetTable.tsx) | None — React Compiler just skips memoizing those two components | **Leave alone.** Expected for TanStack Table; not a code smell to "fix" |
| P3 | [.claude/launch.json](.claude/launch.json) hardcodes the nvm `v24.16.0` binary path | Breaks when Node is upgraded | Default Node is now v24, so this can revert to plain `npx` |
| P4 | Local directory still named `cf-zt-policy-dashboard/` | Cosmetic mismatch with the Flarelens name | Rename the folder |

**Environment note:** `node_modules/` was found empty at the start of this session — `npm test` / `npm run lint` fail with `Cannot find package 'vitest'` until `npm install` is run. Restored and verified green; recorded here because the symptom looks like a code failure but isn't.

---

## Next tasks

| Task | Why | Size | Blocked by |
|---|---|---|---|
| **CI/CD** — GitHub Actions: `npm run check` on PR, deploy on merge to main | Tests and lint exist but nothing enforces them | S | Git remote + `CLOUDFLARE_API_TOKEN` repo secret (deploy-scoped, separate from a browsing token) |
| **Export CSV/JSON** of the filtered view | Deferred twice; the natural "give me this for an audit" ask. Frontend-only, no Worker changes | S | — |
| **Cache range comparison** — current vs previous equivalent window (hit-ratio and volume delta) | Turns a point-in-time number into a trend signal | M | — |
| **Component / integration tests** | Current suite covers pure logic only; UI regressions rely on manual preview checks | M | Testing-library + jsdom setup |
| **Snapshot diff / audit trail** — persist policy snapshots, show what changed between syncs | Biggest product differentiator; answers "who changed what, when" | L | Needs a KV binding — first stateful component in the app |

---

## Conventions

- **Commits:** Conventional Commits, imperative subject ≤50 chars, body only when the *why* isn't obvious.
- **Gate:** `npm run check` (tsc project build → 64 tests → Vite build → wrangler dry-run) must pass before commit. `npm run lint` should show 0 errors (2 known warnings are expected — see P3 above).
- **Verification pattern:** drive the real UI in a preview browser with `window.fetch` stubbed to fixture data, then assert on rendered DOM. Established across every feature in this repo; mobile (375px) and both themes checked for new surfaces.
- **Data honesty (Cache section):** never redistribute unattributed traffic with synthetic weights, never present mock data unlabeled, and let a genuinely quiet zone show zeros. See the note at the end of [README.md](README.md).
