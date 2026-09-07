export interface RequestTraceResult {
	rayId: string;
	window: { since: string; until: string };
	zonesSearched: { id: string; name: string }[];
	foundIn?: { id: string; name: string };
	request?: Record<string, unknown>;
	firewallEvents: Record<string, unknown>[];
	unavailableFields: string[];
	extraFields: string[];
	droppedFields: string[];
	errors: { zone: string; message: string }[];
}

/** Metadata is a key/value list; these two carry the matched fields and the encrypted body. */
export const METADATA_MATCHED_VARS = "matched_vars";
export const METADATA_ENCRYPTED_BODY = "encrypted_matched_data";

export function metadataValue(event: Record<string, unknown>, key: string): string | null {
	const metadata = event.metadata;
	if (!Array.isArray(metadata)) return null;
	for (const entry of metadata) {
		if (entry && typeof entry === "object" && (entry as { key?: string }).key === key) {
			const value = (entry as { value?: unknown }).value;
			return typeof value === "string" ? value : null;
		}
	}
	return null;
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
			["clientRequestReferer", "Referer"],
			["clientRequestBytes", "Request bytes"],
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
			["clientSSLCipher", "Cipher"],
			["clientDeviceType", "Device type"],
			["ja3Hash", "JA3 fingerprint"],
			["ja4", "JA4 fingerprint"],
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
			["botManagementDecision", "Bot decision"],
			["botTags", "Bot tags"],
			["wafAttackScore", "WAF attack score"],
			["wafSqliAttackScore", "WAF SQLi score"],
			["wafXssAttackScore", "WAF XSS score"],
			["wafRceAttackScore", "WAF RCE score"],
			["firewallForAiInjectionScore", "Prompt injection score"],
			["firewallForAiPiiCategories", "PII categories"],
			["firewallForAiUnsafeTopicCategories", "Unsafe topics"],
			["contentScanNumObj", "Scanned objects"],
			["contentScanNumMaliciousObj", "Malicious objects"],
			["contentScanHasFailed", "Content scan failed"],
			["apiGatewayMatchedEndpoint", "API Shield endpoint"],
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
/**
 * A WAF attack score runs 1–99 where **lower is more likely an attack**, the opposite of most
 * scores on this page, so it gets its own threshold rather than sharing the bot-score rule.
 */
export function valueTone(key: string, value: unknown): string {
	if (key.startsWith("waf") && key.endsWith("AttackScore") && typeof value === "number" && value > 0 && value < 40) {
		return "text-red-600 dark:text-red-400";
	}
	if (key === "contentScanNumMaliciousObj" && typeof value === "number" && value > 0) {
		return "text-red-600 dark:text-red-400";
	}
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
