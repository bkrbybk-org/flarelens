// Ported from cf-waf-rules-analyzer src/lib/format.js

import type { RuleMetaEntry } from "./types";

export const normalizeAction = (action: unknown): string => String(action || "unknown").toLowerCase();

export const titleCase = (value: unknown): string =>
	String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const ruleLevel = (meta: Partial<RuleMetaEntry> | undefined): string =>
	meta?.level || (String(meta?.source || "").startsWith("zone") ? "zone" : "account");

export const ruleType = (meta: Partial<RuleMetaEntry> | undefined): string =>
	meta?.type || (meta?.kind === "managed" || meta?.source === "managed" ? "managed" : "custom");

export function relativeTime(iso: string): string {
	if (!iso) return "no activity";
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "no activity";
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) return seconds + "s ago";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return minutes + "m ago";
	const hours = Math.round(minutes / 60);
	if (hours < 24) return hours + "h ago";
	return Math.round(hours / 24) + "d ago";
}

export function axisTimeLabel(ts: number, spanMinutes: number): string {
	const date = new Date(ts);
	if (spanMinutes < 1440) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (spanMinutes < 1440 * 7) return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatBucketTime(value: number): string {
	return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clampNumber(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}
