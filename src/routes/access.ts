import { assertAllowedScope, resolveAuth } from "../lib/auth";
import { fetchCloudflareAll, mapWithConcurrency } from "../lib/cf-rest";
import type { CfApp, CfGroup, CfIdp, CfList, CfListMeta, CfPolicy } from "../cf-types";
import { validHexId } from "../http";
import type { App } from "../env";

/** Cap on items returned per list: this payload is for reading a policy, not exporting a directory. */
const LIST_ITEM_CAP = 500;

/** Zero Trust list ids are UUIDs. */
const LIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Policies for every application, without a request per application.
 *
 * `GET /accounts/{id}/access/apps` already embeds each application's full policy objects —
 * rules, decision, precedence, `reusable` — and they are byte-identical to what
 * `/access/apps/{app}/policies` returns; that was checked against every application on a real
 * account before this replaced the fan-out. Twenty-nine extra round trips at five at a time cost
 * about six seconds, which was most of this route's latency.
 *
 * The fan-out survives as a fallback for applications whose `policies` field is absent. Today
 * that is the `private_ip` type, whose per-application endpoint also returns nothing — but the
 * field being missing and the application genuinely having no policies are different facts, and
 * only one request can tell them apart. Asking for the few rather than assuming about them keeps
 * `policies_error` meaning what it says.
 */
export async function policiesByApp(
	apps: CfApp[],
	accountId: string,
	token: string,
): Promise<Map<string, { policies: CfPolicy[]; error: boolean }>> {
	const byApp = new Map<string, { policies: CfPolicy[]; error: boolean }>();
	const needsFetch: CfApp[] = [];

	for (const appItem of apps) {
		const embedded = (appItem as { policies?: unknown }).policies;
		if (Array.isArray(embedded)) {
			byApp.set(appItem.id, { policies: embedded as CfPolicy[], error: false });
		} else {
			needsFetch.push(appItem);
		}
	}

	const fetched = await mapWithConcurrency(needsFetch, 5, async (appItem) => {
		const res = await fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/apps/${appItem.id}/policies`, token);
		return { appId: appItem.id, policies: res.status === 200 ? res.result : [], error: res.status !== 200 };
	});
	for (const entry of fetched) {
		byApp.set(entry.appId, { policies: entry.policies, error: entry.error });
	}

	return byApp;
}

export function registerAccessRoutes(app: App): void {
	app.get("/api/data", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const token = auth.auth.token;
		const rawAccountId = c.req.query("account_id");
		if (!rawAccountId) {
			return c.json({ success: false, errors: [{ message: "Missing account_id query parameter" }] }, 400);
		}
		// Interpolated into upstream paths below, so it must be an id and nothing else.
		const accountId = validHexId(rawAccountId);
		if (!accountId) {
			return c.json({ success: false, errors: [{ message: "Invalid account_id" }] }, 400);
		}
		const scope = assertAllowedScope(auth.auth, c.env, { accountId });
		if (scope) {
			return c.json({ success: false, errors: [{ message: scope.message }] }, scope.status);
		}

		// 1. Fetch apps, identity providers, groups, and reusable policies
		const [appsRes, idpsRes, groupsRes, reusableRes] = await Promise.all([
			fetchCloudflareAll<CfApp>(`/accounts/${accountId}/access/apps`, token),
			fetchCloudflareAll<CfIdp>(`/accounts/${accountId}/access/identity_providers`, token),
			fetchCloudflareAll<CfGroup>(`/accounts/${accountId}/access/groups`, token),
			fetchCloudflareAll<CfPolicy>(`/accounts/${accountId}/access/policies`, token),
		]);

		if (appsRes.status !== 200) {
			return c.json(
				{ success: false, errors: appsRes.errors || [{ message: "Failed to fetch applications" }] },
				appsRes.status as 200,
			);
		}
		if (idpsRes.status !== 200) {
			return c.json(
				{ success: false, errors: idpsRes.errors || [{ message: "Failed to fetch identity providers" }] },
				idpsRes.status as 200,
			);
		}

		const apps = appsRes.result;
		const idps = idpsRes.result;
		// Groups and reusable policies are enrichment data; tokens without those
		// read scopes still get the core app/policy view. Surface the failure so
		// the connect screen can report the scope as missing rather than "empty".
		const groups = groupsRes.status === 200 ? groupsRes.result : [];
		const groupsError = groupsRes.status !== 200;
		const reusablePolicies = reusableRes.status === 200 ? reusableRes.result : [];
		const reusablePoliciesError = reusableRes.status !== 200;

		// 2. Policies per application — read from the apps payload, fetched only where it is absent.
		const policyMap = await policiesByApp(apps, accountId, token);

		// 2b. Resolve the Zero Trust lists that policies reference.
		//
		// A rule reading "Email in list 55e12a45-…" is unreviewable: the whole point of a policy
		// review is knowing who it lets in. Only lists actually referenced are expanded — an account
		// can hold large lists this page has no reason to read — and items are capped, because the
		// payload is for reading, not for exporting a directory.
		const referencedListIds = new Set<string>();
		const scanRules = (rules: unknown) => {
			if (!Array.isArray(rules)) return;
			for (const rule of rules) {
				if (!rule || typeof rule !== "object") continue;
				for (const [key, value] of Object.entries(rule as Record<string, unknown>)) {
					if (!key.endsWith("_list") || !value || typeof value !== "object") continue;
					const id = (value as { id?: unknown }).id;
					// Interpolated into an upstream path, so only something shaped like a list id.
					if (typeof id === "string" && LIST_ID_PATTERN.test(id)) referencedListIds.add(id);
				}
			}
		};
		const scanPolicy = (policy: { include?: unknown; exclude?: unknown; require?: unknown }) => {
			scanRules(policy.include);
			scanRules(policy.exclude);
			scanRules(policy.require);
		};
		for (const policy of reusablePolicies) scanPolicy(policy);
		for (const group of groups) scanPolicy(group as { include?: unknown });
		for (const entry of policyMap.values()) {
			for (const policy of entry.policies) scanPolicy(policy);
		}

		let lists: CfList[] = [];
		let listsError = false;
		if (referencedListIds.size > 0) {
			const listsRes = await fetchCloudflareAll<CfListMeta>(`/accounts/${accountId}/gateway/lists`, token);
			listsError = listsRes.status !== 200;
			const byId = new Map((listsRes.result || []).map((entry) => [entry.id, entry]));

			lists = await mapWithConcurrency([...referencedListIds], 5, async (id) => {
				const meta = byId.get(id);
				const itemsRes = await fetchCloudflareAll<{ value?: string }>(`/accounts/${accountId}/gateway/lists/${id}/items`, token);
				const values = (itemsRes.result || []).map((item) => item.value).filter((v): v is string => !!v);
				return {
					id,
					name: meta?.name || id,
					type: meta?.type || "",
					// The list's own count, which stands even when items could not be read.
					count: typeof meta?.count === "number" ? meta.count : values.length,
					items: values.slice(0, LIST_ITEM_CAP),
					items_truncated: values.length > LIST_ITEM_CAP,
					error: itemsRes.status !== 200 ? itemsRes.errors?.[0]?.message || `HTTP ${itemsRes.status}` : undefined,
				};
			});
		}

		// 3. Merge policies into applications and map fields
		const enrichedApps = apps.map((appItem) => {
			const entry = policyMap.get(appItem.id);
			return {
				...appItem,
				policies: entry?.policies || [],
				policies_error: entry?.error || false,
				self_hosted_domains: appItem.self_hosted_domains || (appItem.domain ? [appItem.domain] : []),
			};
		});

		return c.json({
			success: true,
			result: {
				apps: enrichedApps,
				idps,
				groups,
				groups_error: groupsError,
				reusable_policies: reusablePolicies,
				reusable_policies_error: reusablePoliciesError,
				lists,
				lists_error: listsError,
			},
		});
	});
}
