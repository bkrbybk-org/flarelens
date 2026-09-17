/** Mirrors src/lib/dns-records.ts: TTL 1 is Cloudflare's "automatic" sentinel, not one second. */
export function isAutoTtl(ttl: number): boolean {
	return ttl === 1;
}

export function formatTtl(ttl: number): string {
	return isAutoTtl(ttl) ? "Auto" : `${ttl}s`;
}
