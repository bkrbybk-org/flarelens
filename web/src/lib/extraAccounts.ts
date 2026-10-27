/**
 * Accounts added for this browser tab with their own API token.
 *
 * The deployment's own credential reaches the accounts on its allowlist; anything else needs a
 * token of its own. An operator pastes one in, picks which of the accounts it can see to add, and
 * from then on requests for those accounts carry that token as a Bearer header — the worker always
 * prefers a caller's Bearer over its bound token, and Cloudflare enforces the token's own scope.
 *
 * Kept in session storage only, like a pasted token on the connect screen: it lives as long as the
 * tab, is never written to localStorage or sent anywhere but this app's own API, and disconnecting
 * clears it. Every read and write goes through lib/storage.ts, which never throws.
 */

import { storageGet, storageRemove, storageSet } from "./storage";

const KEY = "flarelens_extra_accounts";

export interface ExtraAccount {
	id: string;
	name: string;
	token: string;
}

const HEX_ID = /^[a-f0-9]{32}$/i;

function isExtraAccount(value: unknown): value is ExtraAccount {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && HEX_ID.test(v.id) && typeof v.name === "string" && typeof v.token === "string" && v.token.length > 0;
}

export function listExtraAccounts(): ExtraAccount[] {
	try {
		const parsed = JSON.parse(storageGet("session", KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter(isExtraAccount) : [];
	} catch {
		return [];
	}
}

/** Adds or replaces (by account id) — a fresh token for an account supersedes the old one. */
export function addExtraAccounts(accounts: ExtraAccount[]): ExtraAccount[] {
	const incoming = accounts.filter(isExtraAccount);
	const ids = new Set(incoming.map((a) => a.id));
	const next = [...listExtraAccounts().filter((a) => !ids.has(a.id)), ...incoming];
	storageSet("session", KEY, JSON.stringify(next));
	return next;
}

export function removeExtraAccount(id: string): ExtraAccount[] {
	const next = listExtraAccounts().filter((a) => a.id !== id);
	storageSet("session", KEY, JSON.stringify(next));
	return next;
}

export function clearExtraAccounts(): void {
	storageRemove("session", KEY);
}
