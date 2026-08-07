// WAF and Cache data are fetched by useWafData/useCacheData inside WafPage
// and CachePage, which unmount when the user navigates away — there is no
// App-level state to read. Rather than lifting that state into App or
// re-fetching from FindingsPage, each page publishes its last-loaded result
// into this tiny external store, and FindingsPage subscribes to it. Fetching
// stays exactly where it already lives; this only carries the latest snapshot
// across a page unmount.
//
// Snapshots are stamped with the account they came from and readers must pass
// the account they expect. Switching accounts therefore invalidates them
// automatically: without this, a snapshot captured for one customer would keep
// being reported under the next one, and the Findings page would claim it had
// "checked" a section it had not.
import { useSyncExternalStore } from "react";
import type { CacheAnalysis } from "../features/cache/types";
import type { FirewallEvent, RuleMetaMap } from "./waf/types";

export interface WafSnapshot {
	events: FirewallEvent[];
	ruleMeta: RuleMetaMap;
}

interface Scoped<T> {
	accountId: string;
	value: T;
}

let wafSnapshot: Scoped<WafSnapshot> | null = null;
let cacheSnapshot: Scoped<CacheAnalysis> | null = null;
const wafListeners = new Set<() => void>();
const cacheListeners = new Set<() => void>();

export function publishWafSnapshot(accountId: string, snapshot: WafSnapshot): void {
	wafSnapshot = { accountId, value: snapshot };
	for (const l of wafListeners) l();
}

export function publishCacheSnapshot(accountId: string, snapshot: CacheAnalysis): void {
	cacheSnapshot = { accountId, value: snapshot };
	for (const l of cacheListeners) l();
}

/** Drop everything held in memory — call on disconnect. */
export function clearSectionSnapshots(): void {
	wafSnapshot = null;
	cacheSnapshot = null;
	for (const l of wafListeners) l();
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

/** The account guard, split out so it is testable without a React renderer. */
export function scopedValue<T>(scoped: Scoped<T> | null, accountId: string): T | null {
	return scoped && scoped.accountId === accountId ? scoped.value : null;
}

// Non-hook readers, for tests.
export function readWafSnapshot(accountId: string): WafSnapshot | null {
	return scopedValue(wafSnapshot, accountId);
}

export function readCacheSnapshot(accountId: string): CacheAnalysis | null {
	return scopedValue(cacheSnapshot, accountId);
}

// getSnapshot returns the stored reference itself (stable between publishes);
// the account check happens after, so useSyncExternalStore never sees a new
// object identity on every render.
export function useWafSnapshot(accountId: string): WafSnapshot | null {
	return scopedValue(useSyncExternalStore(subscribeWaf, () => wafSnapshot), accountId);
}

export function useCacheSnapshot(accountId: string): CacheAnalysis | null {
	return scopedValue(useSyncExternalStore(subscribeCache, () => cacheSnapshot), accountId);
}
