/**
 * Saved views: a name plus the full hash (route + query params) of wherever the operator was
 * standing, scoped to the account they saved it under.
 *
 * Every read and write is wrapped in try/catch — localStorage can throw (private browsing,
 * storage quota, disabled entirely) or simply not exist, and losing this feature is not a
 * reason to break the section that called it.
 */

const STORAGE_KEY = "flarelens_saved_views";

/** Per account, not overall — a busy account should not crowd out a quieter one. */
const CAP_PER_ACCOUNT = 50;

export interface SavedView {
	id: string;
	name: string;
	/** Always `#/<route>?...`, validated with {@link isNavigableHash} before use. */
	hash: string;
	accountId: string;
	/** `Date.now()` at save time. */
	createdAt: number;
}

function isValidView(value: unknown): value is SavedView {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		v.id.length > 0 &&
		typeof v.name === "string" &&
		v.name.length > 0 &&
		typeof v.hash === "string" &&
		v.hash.startsWith("#/") &&
		typeof v.accountId === "string" &&
		v.accountId.length > 0 &&
		typeof v.createdAt === "number" &&
		Number.isFinite(v.createdAt)
	);
}

function readAll(): SavedView[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidView);
	} catch {
		return [];
	}
}

function writeAll(views: SavedView[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
	} catch {
		// Storage unavailable or full: the save silently doesn't happen rather than throwing
		// through a click handler.
	}
}

function randomId(): string {
	try {
		if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
	} catch {
		// fall through
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Strictly increasing, even across calls within the same millisecond — two views saved back to
 * back (or by a test with no delay between them) must still sort in the order they were created.
 */
let lastCreatedAt = 0;
function nextCreatedAt(): number {
	lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
	return lastCreatedAt;
}

/** Views for one account, newest first. Never lists another account's. */
export function listViews(accountId: string): SavedView[] {
	return readAll()
		.filter((v) => v.accountId === accountId)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function saveView(accountId: string, name: string, hash: string): SavedView {
	const trimmed = name.trim() || "Untitled view";
	const view: SavedView = { id: randomId(), name: trimmed, hash, accountId, createdAt: nextCreatedAt() };
	const all = readAll();
	const others = all.filter((v) => v.accountId !== accountId);
	const forAccount = all.filter((v) => v.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt);
	// Cap per account by dropping the oldest, not by refusing the save.
	const nextForAccount = [...forAccount, view].slice(-CAP_PER_ACCOUNT);
	writeAll([...others, ...nextForAccount]);
	return view;
}

export function renameView(accountId: string, id: string, name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	const all = readAll();
	writeAll(all.map((v) => (v.accountId === accountId && v.id === id ? { ...v, name: trimmed } : v)));
}

export function deleteView(accountId: string, id: string): void {
	const all = readAll();
	writeAll(all.filter((v) => !(v.accountId === accountId && v.id === id)));
}

/** True when `hash` starts with `#/` and names a route this build actually has. */
export function isNavigableHash(hash: string, knownRoutes: readonly string[]): boolean {
	if (!hash.startsWith("#/")) return false;
	const route = hash.slice(2).split("?")[0];
	return (knownRoutes as string[]).includes(route);
}

/**
 * Navigates to a saved view's hash, once validated.
 *
 * A plain module-level function rather than inlined at the call site: React Compiler's
 * immutability check treats a direct `window.location.hash = …` assignment inside a component
 * body as mutating a value it doesn't own, which it does not raise for a call out to a function
 * defined outside any component.
 */
export function navigateToView(view: Pick<SavedView, "hash">, knownRoutes: readonly string[]): void {
	if (isNavigableHash(view.hash, knownRoutes)) {
		window.location.hash = view.hash.replace(/^#/, "");
	}
}
