import { useEffect, useRef } from "react";

// Hash format: #/route?key=value&… — route part handled by useRoute,
// query part here. Deep links win over persisted prefs on first load.

export function getHashParams(): URLSearchParams {
	const hash = window.location.hash;
	const q = hash.indexOf("?");
	return new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
}

export function setHashParam(key: string, value: string | null): void {
	const hash = window.location.hash;
	const q = hash.indexOf("?");
	const route = q === -1 ? hash : hash.slice(0, q);
	const params = getHashParams();
	if (value === null || value === "") {
		params.delete(key);
	} else {
		params.set(key, value);
	}
	const qs = params.toString();
	// With no fragment at all (a fresh load of "/"), `route` is empty and a bare `?key=value`
	// would be read by replaceState as the page's QUERY STRING, rewriting the real URL and
	// dropping the path. Anchor to the default route instead.
	const base = route.startsWith("#") ? route : "#/";
	const next = qs ? `${base}?${qs}` : base;
	if (next !== hash) {
		// replaceState avoids polluting history on every control change
		history.replaceState(null, "", next);
	}
}

/**
 * Two-way sync between a hash query param and a piece of state:
 * on mount the URL value (if present and different) wins and is pushed
 * into state; afterwards state changes are mirrored back into the hash.
 */
export function useHashSyncedState(key: string, value: string, setValue: (next: string) => void): void {
	const appliedRef = useRef(false);

	useEffect(() => {
		if (appliedRef.current) return;
		appliedRef.current = true;
		const fromUrl = getHashParams().get(key);
		if (fromUrl !== null && fromUrl !== value) {
			setValue(fromUrl);
		}
		// Mount-only URL adoption
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!appliedRef.current) return;
		setHashParam(key, value || null);
	}, [key, value]);
}
