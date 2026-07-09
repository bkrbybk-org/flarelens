import { useCallback, useEffect, useState } from "react";

export type Route = "access" | "waf" | "cache";

const ROUTES: Route[] = ["access", "waf", "cache"];

function parseHash(): Route {
	const hash = window.location.hash.replace(/^#\/?/, "");
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
