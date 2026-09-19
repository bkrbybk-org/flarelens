import type { Route } from "../../hooks/useRoute";
import {
	AlertIcon,
	AppsIcon,
	BoltIcon,
	ChartIcon,
	CoinIcon,
	DatabaseIcon,
	GlobeIcon,
	KeyIcon,
	LockIcon,
	PulseIcon,
	RouteIcon,
	SearchIcon,
	ShareIcon,
	ShieldIcon,
	SparkIcon,
	UsersIcon,
} from "../Icons";

/**
 * Navigation grouped by the Cloudflare product area each section reads from.
 *
 * The single source for both the sidebar and the command palette: a route that only appeared in
 * one of the two used to be possible by construction, since each kept its own list. Both now
 * read this, and [tests/components/CommandPalette.test.tsx](../../../../tests/components/CommandPalette.test.tsx)
 * checks every `Route` from `useRoute`'s `ROUTES` appears here exactly once.
 */
export const NAV_GROUPS: { label: string; items: { route: Route; label: string; icon: typeof AppsIcon }[] }[] = [
	{
		label: "Zero Trust",
		items: [
			{ route: "access", label: "Access Applications", icon: AppsIcon },
			{ route: "groups", label: "Access Groups", icon: UsersIcon },
			{ route: "access-usage", label: "Access Usage", icon: ChartIcon },
			{ route: "tunnels", label: "Tunnel Map", icon: ShareIcon },
			{ route: "gateway", label: "Gateway Usage", icon: GlobeIcon },
		],
	},
	{
		label: "Security",
		items: [
			{ route: "waf", label: "WAF Analytics", icon: ShieldIcon },
			{ route: "ai-security", label: "AI Security", icon: KeyIcon },
			{ route: "request", label: "Request Trace", icon: SearchIcon },
			{ route: "pqc", label: "PQC Readiness", icon: LockIcon },
			{ route: "zone-health", label: "Zone Health", icon: PulseIcon },
			{ route: "dns", label: "DNS Records", icon: GlobeIcon },
			{ route: "bots", label: "Rate Limits & Bots", icon: BoltIcon },
			{ route: "shields", label: "Page & API Shield", icon: ShieldIcon },
		],
	},
	{
		label: "Performance",
		items: [{ route: "cache", label: "Cache Rules", icon: DatabaseIcon }],
	},
	{
		label: "Developer Platform",
		items: [
			{ route: "workers", label: "Workers Analytics", icon: BoltIcon },
			{ route: "workers-ai", label: "Workers AI", icon: SparkIcon },
			{ route: "ai-gateway", label: "AI Gateway", icon: RouteIcon },
			{ route: "cost", label: "Cost & Usage", icon: CoinIcon },
		],
	},
	{
		label: "Audit",
		items: [{ route: "findings", label: "Findings", icon: AlertIcon }],
	},
];
