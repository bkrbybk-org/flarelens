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
 * Two-way sync between a hash query param and a piece of state: on arrival at
 * `route` the URL value (if present and different) wins and is pushed into
 * state; afterwards state changes are mirrored back into the hash.
 *
 * Keyed on `route`, not just mount, because the App shell never unmounts —
 * hand-editing the hash to a different route (e.g. #/waf?zone=A to
 * #/cache?zone=B) is a real arrival at that route and must re-adopt, even
 * though no component remounted to give us a fresh mount effect for free.
 */
export function useHashSyncedState(key: string, value: string, setValue: (next: string) => void, route: string): void {
	const appliedRouteRef = useRef<string | null>(null);

	useEffect(() => {
		if (appliedRouteRef.current !== route) {
			appliedRouteRef.current = route;
			const fromUrl = getHashParams().get(key);
			if (fromUrl !== null && fromUrl !== value) {
				setValue(fromUrl);
				// Adoption above lands as a state update; let the re-render this
				// triggers carry the adopted value before writing back, so the
				// write-back below never fires against the pre-adoption value.
				return;
			}
		}
		setHashParam(key, value || null);
		// `setValue` deliberately excluded: callers pass a fresh closure every render, and
		// this effect must only re-run when the key/value/route it actually reads changes —
		// not on every render of the parent.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, value, route]);
}
