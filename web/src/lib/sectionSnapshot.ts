// WAF and Cache data are fetched by useWafData/useCacheData inside WafPage
// and CachePage, which unmount when the user navigates away — there is no
// App-level state to read. Rather than lifting that state into App (out of
// scope per the Findings design) or re-fetching from FindingsPage, each page
// publishes its last-loaded result into this tiny external store, and
// FindingsPage subscribes to it. Fetching stays exactly where it already
// lives; this only carries the latest snapshot across a page unmount.
import { useSyncExternalStore } from "react";
import type { CacheAnalysis } from "../features/cache/types";
import type { FirewallEvent, RuleMetaMap } from "./waf/types";

export interface WafSnapshot {
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
}

let wafSnapshot: WafSnapshot | null = null;
let cacheSnapshot: CacheAnalysis | null = null;
const wafListeners = new Set<() => void>();
const cacheListeners = new Set<() => void>();

export function publishWafSnapshot(snapshot: WafSnapshot): void {
	wafSnapshot = snapshot;
	for (const l of wafListeners) l();
}

export function publishCacheSnapshot(snapshot: CacheAnalysis): void {
	cacheSnapshot = snapshot;
	for (const l of cacheListeners) l();
}

function subscribeWaf(cb: () => void): () => void {
	wafListeners.add(cb);
	return () => wafListeners.delete(cb);
}

function subscribeCache(cb: () => void): () => void {
	cacheListeners.add(cb);
	return () => cacheListeners.delete(cb);
}

export function useWafSnapshot(): WafSnapshot | null {
	return useSyncExternalStore(subscribeWaf, () => wafSnapshot);
}

export function useCacheSnapshot(): CacheAnalysis | null {
	return useSyncExternalStore(subscribeCache, () => cacheSnapshot);
}
