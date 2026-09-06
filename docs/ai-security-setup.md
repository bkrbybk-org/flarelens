# AI Security for Apps — enablement and payload logging

Operator notes for the `#/ai-security` section: what has to be true on the Cloudflare side
before this dashboard shows anything, and where the private key that decrypts prompts comes from.

Captured from the standalone `ai-sec-dashboard` Worker's Setup page before that deployment was
retired. Field names and the managed ruleset id are cross-checked against
[src/lib/ai-sec/cf/schema.ts](../src/lib/ai-sec/cf/schema.ts) and
[src/lib/ai-sec/cf/queries.ts](../src/lib/ai-sec/cf/queries.ts), which query them.

## Requirements

- Enterprise plan with the **AI Security for Apps** add-on, and WAF enabled on the zone.
- LLM endpoint discovery is available on all plans; the `cf.llm.*` **detection fields are not**.

## Turning it on

1. Enable AI Security for Apps in the zone's security settings (or `PUT` to the AI security
   settings endpoint).
2. **Label the endpoints `cf-llm`.** Cloudflare auto-discovers endpoints for proxied domains, and
   they can also be added manually by method + path + hostname. Nothing is scanned until the
   endpoint carries the `cf-llm` managed label, and only `application/json` requests are scanned.
3. Validate in Security Analytics: filter on `Managed Endpoint Label equals cf-llm` and inspect
   the **Analyses** column in sampled logs. This dashboard reads the same signals.

## Log Mode vs Production Mode

|  | Production Mode | Log Mode |
|---|---|---|
| Setup | Custom rules you write on the detection fields | Pre-built managed ruleset (id ends `d385e336`) |
| Prompt logging | No — request metadata only | Full request body captured, encrypted |
| Flexibility | Score thresholds, PII categories, combined signals | Three fixed rules: PII, unsafe topic, prompt injection |
| Best for | Live enforcement | Evaluation and threshold tuning |

Example mitigation rules on the detection fields:

```
(cf.llm.prompt.pii_detected and http.host == "example.com")
(cf.llm.prompt.pii_detected and cf.bot_management.score lt 10)
(cf.llm.prompt.injection_score lt 20)
(cf.llm.prompt.unsafe_topic_detected and any(cf.llm.prompt.unsafe_topic_categories[*] in {"S2" "S10"}))
```

## Reading actual prompt text (payload logging)

The GraphQL Analytics API exposes detection *verdicts*, never prompt content. To read prompts:

1. Enable the **AI Security Log Mode Ruleset** on the zone.
2. Configure **payload logging** for that managed ruleset with a public key — generate the key
   pair in the Cloudflare dashboard, or supply your own from `matched-data-cli`. Cloudflare stores
   only the public key. **Only a Super Administrator can configure this.**
3. Decrypt with the private key: in this dashboard's Events tab, with `matched-data-cli` on the
   command line, or in a Worker before shipping logs to a SIEM.

Keep the private key as a production secret. Payload logging captures the prompts users actually
sent, including any PII in them, so prefer Log Mode for a bounded evaluation window rather than as
a permanent setting.

This app decrypts in the browser only — the key is never sent to the Worker, which only ever
handles ciphertext, and never stored, so it is re-entered each session. Format details are in
[matchedData.ts](../web/src/features/ai-security/matchedData.ts).

## Detection fields the token must resolve

The section probes the schema at runtime and hides whatever it cannot back
([schema.ts](../src/lib/ai-sec/cf/schema.ts)). On the reference account these resolve on
`httpRequestsAdaptive`:

| Signal | Field |
|---|---|
| Injection score | `firewallForAiInjectionScore` |
| PII categories | `firewallForAiPiiCategories` |
| Unsafe topic categories | `firewallForAiUnsafeTopicCategories` |
| Custom topic categories | `firewallForAiCustomTopicCategories`, `…ScoresMin` |
| Managed endpoint label | `webAssetsLabelsManaged` |

**Token count is not exposed on `httpRequestsAdaptive` in GraphQL** — it is Logpush-only, so the
token KPI stays hidden. That is a Cloudflare limitation, not a missing scope.

## Token permissions

The standalone dashboard ran entirely zone-scoped: **Zone : Analytics : Read** and
**Zone : Zone : Read**, with no account-level permissions. This app is account-scoped elsewhere,
so see the scope table in [README.md](../README.md#api-token-scopes).
