export interface RequestTraceResult {
	rayId: string;
	window: { since: string; until: string };
	zonesSearched: { id: string; name: string }[];
	foundIn?: { id: string; name: string };
	request?: Record<string, unknown>;
	firewallEvents: Record<string, unknown>[];
	unavailableFields: string[];
	errors: { zone: string; message: string }[];
}

/**
 * Field groups, in the order an analyst reads them: what was asked for, who asked, what
 * Cloudflare decided, and how it performed. Fields absent from the response are skipped, so a
 * plan without bot management simply shows a shorter Security group.
 */
export const FIELD_GROUPS: { title: string; fields: [string, string][] }[] = [
	{
		title: "Request",
		fields: [
			["datetime", "Time"],
			["clientRequestHTTPMethodName", "Method"],
			["clientRequestHTTPHost", "Host"],
			["clientRequestPath", "Path"],
			["clientRequestQuery", "Query"],
			["clientRequestScheme", "Scheme"],
			["clientRequestHTTPProtocol", "Protocol"],
		],
	},
	{
		title: "Client",
		fields: [
			["clientIP", "IP"],
			["clientCountryName", "Country"],
			["clientASNDescription", "Network"],
			["clientAsn", "ASN"],
			["userAgent", "User agent"],
			["clientRequestUserAgent", "User agent"],
			["clientSSLProtocol", "TLS"],
			["ja3Hash", "JA3"],
			["ja4", "JA4"],
		],
	},
	{
		title: "Security",
		fields: [
			["securityAction", "Action"],
			["securitySource", "Source"],
			["securityRuleId", "Rule id"],
			["securityRuleDescription", "Rule"],
			["botScore", "Bot score"],
			["botScoreSrcName", "Bot score source"],
			["wafAttackScore", "WAF attack score"],
			["wafSqliAttackScore", "WAF SQLi score"],
			["wafXssAttackScore", "WAF XSS score"],
			["wafRceAttackScore", "WAF RCE score"],
			["firewallForAiInjectionScore", "Prompt injection score"],
			["firewallForAiPiiCategories", "PII categories"],
			["firewallForAiUnsafeTopicCategories", "Unsafe topics"],
		],
	},
	{
		title: "Response and edge",
		fields: [
			["edgeResponseStatus", "Edge status"],
			["originResponseStatus", "Origin status"],
			["edgeResponseContentTypeName", "Content type"],
			["edgeResponseBytes", "Bytes"],
			["edgeTimeToFirstByteMs", "Edge TTFB"],
			["originResponseDurationMs", "Origin duration"],
			["cacheStatus", "Cache"],
			["cacheCacheStatus", "Cache"],
			["coloCode", "Colo"],
			["edgeColoCode", "Colo"],
		],
	},
];

export function formatValue(key: string, value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
	if (key.endsWith("Ms") || key === "originResponseDurationMs") return `${value} ms`;
	if (key === "datetime") {
		const date = new Date(String(value));
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	}
	return String(value);
}

/**
 * A low prompt-injection score or a high bot score is the interesting case, so those get a tone.
 * Everything else renders plain — colour that means nothing is worse than none.
 */
export function valueTone(key: string, value: unknown): string {
	if (key === "firewallForAiInjectionScore" && typeof value === "number" && value < 20) {
		return "text-red-600 dark:text-red-400";
	}
	if (key === "botScore" && typeof value === "number" && value > 0 && value <= 30) {
		return "text-red-600 dark:text-red-400";
	}
	if (key === "securityAction" && typeof value === "string" && ["block", "challenge", "managed_challenge"].includes(value)) {
		return "text-red-600 dark:text-red-400";
	}
	if ((key === "edgeResponseStatus" || key === "originResponseStatus") && typeof value === "number" && value >= 400) {
		return "text-amber-700 dark:text-amber-400";
	}
	if (Array.isArray(value) && value.length > 0) return "text-amber-700 dark:text-amber-400";
	return "";
}
