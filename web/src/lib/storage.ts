/**
 * Web Storage that cannot throw.
 *
 * Merely touching `localStorage` or `sessionStorage` throws a SecurityError when the browser
 * blocks site data, and a write throws when storage is full. Neither is a reason to take the app
 * down, so every read here falls back to null and every write is best-effort.
 */

type Area = "local" | "session";

function area(which: Area): Storage | null {
	try {
		return which === "local" ? window.localStorage : window.sessionStorage;
	} catch {
		return null;
	}
}

export function storageGet(which: Area, key: string): string | null {
	try {
		return area(which)?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function storageSet(which: Area, key: string, value: string): void {
	try {
		area(which)?.setItem(key, value);
	} catch {
		// Best-effort: the value simply does not persist.
	}
}

export function storageRemove(which: Area, key: string): void {
	try {
		area(which)?.removeItem(key);
	} catch {
		// Nothing stored, or nothing reachable to remove it from.
	}
}
