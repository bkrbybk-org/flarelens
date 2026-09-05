import { useCallback, useEffect, useState } from "react";

export type Route = "access" | "groups" | "waf" | "cache" | "ai-security" | "workers" | "workers-ai" | "access-usage" | "findings";

const ROUTES: Route[] = ["access", "groups", "waf", "cache", "ai-security", "workers", "workers-ai", "access-usage", "findings"];

function parseHash(): Route {
	// Route is the path part only; query params (#/waf?zone=…) belong to useHashParams
	const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
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
