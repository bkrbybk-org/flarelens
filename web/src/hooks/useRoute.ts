import { useCallback, useEffect, useState } from "react";

export type Route = "access" | "groups" | "waf" | "cache" | "ai-security" | "request" | "workers" | "workers-ai" | "ai-gateway" | "access-usage" | "tunnels" | "gateway" | "gateway-policies" | "pqc" | "zone-health" | "dns" | "bots" | "cost" | "findings" | "shields" | "audit" | "access-tester";

export const ROUTES: Route[] = ["access", "groups", "waf", "cache", "ai-security", "request", "workers", "workers-ai", "ai-gateway", "access-usage", "tunnels", "gateway", "gateway-policies", "pqc", "zone-health", "dns", "bots", "cost", "findings", "shields", "audit", "access-tester"];

/** Routes that were merged into another page; their links (and query) land on the new one. */
const ALIASES: Record<string, Route> = { why: "request" };

function parseHash(): Route {
	// Route is the path part only; query params (#/waf?zone=…) belong to useHashParams
	const [hash, query] = window.location.hash.replace(/^#\/?/, "").split("?");
	const alias = ALIASES[hash];
	if (alias) {
		history.replaceState(null, "", `#/${alias}${query ? `?${query}` : ""}`);
		return alias;
	}
	return (ROUTES as string[]).includes(hash) ? (hash as Route) : "access";
}

export function useRoute(): [Route, (route: Route) => void] {
	const [route, setRoute] = useState<Route>(parseHash);

	useEffect(() => {
		const onHashChange = () => setRoute(parseHash());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const navigate = useCallback((next: Route) => {
		window.location.hash = `/${next}`;
	}, []);

	return [route, navigate];
}
