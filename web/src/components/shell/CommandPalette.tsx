import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "../../hooks/useRoute";
import type { Theme } from "../../hooks/usePrefs";
import type { CfAccount } from "../../types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { listViews, isNavigableHash } from "../../lib/savedViews";
import { ROUTES } from "../../hooks/useRoute";
import { NAV_GROUPS } from "./nav";
import {
	BookmarkIcon,
	LogoutIcon,
	MonitorIcon,
	MoonIcon,
	PanelLeftIcon,
	RefreshIcon,
	SearchIcon,
	SunIcon,
} from "../Icons";

const RECENT_KEY = "flarelens_recent_commands";
const RECENT_CAP = 5;

/** 16 hex chars, optionally suffixed with a colo like `-BKK`. */
const RAY_ID_RE = /^[0-9a-f]{16}(-[a-zA-Z0-9]{3})?$/;

function readRecent(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function pushRecent(id: string): void {
	try {
		const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_CAP);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// best-effort
	}
}

interface Command {
	id: string;
	label: string;
	group: string;
	keywords?: string;
	icon?: (p: { size?: number }) => React.ReactElement;
	run: () => void;
}

/** Matches `query` against `text`: contiguous substring first (better score), else in-order subsequence. */
function fuzzyMatch(text: string, query: string): { score: number; ranges: [number, number][] } | null {
	if (!query) return { score: 0, ranges: [] };
	const t = text.toLowerCase();
	const q = query.toLowerCase();
	const idx = t.indexOf(q);
	if (idx !== -1) return { score: 1000 - idx, ranges: [[idx, idx + q.length]] };

	let ti = 0;
	const ranges: [number, number][] = [];
	let start = -1;
	let runEnd = -1;
	for (let qi = 0; qi < q.length; qi++) {
		const found = t.indexOf(q[qi], ti);
		if (found === -1) return null;
		if (start === -1) {
			start = found;
			runEnd = found + 1;
		} else if (found === runEnd) {
			runEnd = found + 1;
		} else {
			ranges.push([start, runEnd]);
			start = found;
			runEnd = found + 1;
		}
		ti = found + 1;
	}
	if (start !== -1) ranges.push([start, runEnd]);
	return { score: 0, ranges };
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
	if (!ranges.length) return <>{text}</>;
	const parts: React.ReactNode[] = [];
	let cursor = 0;
	ranges.forEach(([start, end], i) => {
		// Plain strings, not <span>-wrapped, for the non-highlighted stretches: the accessible
		// name algorithm trims each element's own text before joining, so a leading/trailing
		// space wrapped in its own <span> is dropped at the boundary and "WAF Analytics" reads
		// as "WAFAnalytics" to assistive tech. A bare text node has no such boundary to trim.
		if (start > cursor) parts.push(text.slice(cursor, start));
		parts.push(
			<mark key={`m${i}`} className="rounded-sm bg-cf/25 text-inherit">
				{text.slice(start, end)}
			</mark>,
		);
		cursor = end;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	return <>{parts}</>;
}

export interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	route: Route;
	onNavigate: (route: Route) => void;
	accounts: CfAccount[];
	accountId: string;
	onSwitchAccount: (account: CfAccount) => void;
	theme: Theme;
	onSetTheme: (theme: Theme) => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	onRefresh?: () => void;
	refreshing: boolean;
	showRefresh: boolean;
	onDisconnect: () => void;
	onSaveView: () => void;
}

export function CommandPalette({
	open,
	onOpenChange,
	route,
	onNavigate,
	accounts,
	accountId,
	onSwitchAccount,
	theme,
	onSetTheme,
	collapsed,
	onToggleCollapsed,
	onRefresh,
	refreshing,
	showRefresh,
	onDisconnect,
	onSaveView,
}: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useFocusTrap(containerRef, open, () => onOpenChange(false));

	// Global shortcut — this component is always mounted, so it is the one place to listen.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				onOpenChange(true);
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onOpenChange]);

	// Read fresh on every open rather than pushed from an effect — a view saved elsewhere
	// (Topbar, this same palette a moment ago) must show up the next time this opens.
	const views = useMemo(() => (open ? listViews(accountId) : []), [open, accountId]);

	// Reset the query and the active row when the palette transitions to open, and the active
	// row again whenever the query changes — both are "state derived from a change", adjusted
	// during render rather than in an effect: https://react.dev/learn/you-might-not-need-an-effect
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setQuery("");
			setActiveIndex(0);
		}
	}
	const [prevQuery, setPrevQuery] = useState(query);
	if (query !== prevQuery) {
		setPrevQuery(query);
		setActiveIndex(0);
	}

	useEffect(() => {
		// Focus trap already moved focus into the container; the input still needs it.
		if (open) requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	const commands = useMemo<Command[]>(() => {
		const out: Command[] = [];

		for (const group of NAV_GROUPS) {
			for (const item of group.items) {
				if (item.route === route) continue;
				out.push({
					id: `nav:${item.route}`,
					label: item.label,
					group: group.label,
					icon: item.icon,
					run: () => onNavigate(item.route),
				});
			}
		}

		if (accounts.length > 1) {
			for (const account of accounts) {
				if (account.id === accountId) continue;
				out.push({
					id: `account:${account.id}`,
					label: `Switch to ${account.name || account.id}`,
					group: "Switch account",
					run: () => onSwitchAccount(account),
				});
			}
		}

		const themes: { key: Theme; label: string; icon: Command["icon"] }[] = [
			{ key: "dark", label: "Dark", icon: MoonIcon },
			{ key: "light", label: "Light", icon: SunIcon },
			{ key: "system", label: "System", icon: MonitorIcon },
		];
		for (const t of themes) {
			if (t.key === theme) continue;
			out.push({
				id: `theme:${t.key}`,
				label: `Set theme: ${t.label}`,
				group: "Appearance",
				icon: t.icon,
				run: () => onSetTheme(t.key),
			});
		}
		out.push({
			id: "sidebar:toggle",
			label: collapsed ? "Expand sidebar" : "Collapse sidebar",
			group: "Appearance",
			icon: PanelLeftIcon,
			run: onToggleCollapsed,
		});

		if (showRefresh && onRefresh) {
			out.push({
				id: "refresh",
				label: refreshing ? "Refreshing…" : "Refresh current section",
				group: "Actions",
				icon: RefreshIcon,
				run: onRefresh,
			});
		}

		out.push({
			id: "action:save-view",
			label: "Save current view…",
			group: "Actions",
			icon: BookmarkIcon,
			run: onSaveView,
		});

		for (const view of views) {
			out.push({
				id: `view:${view.id}`,
				label: view.name,
				group: "Saved views",
				icon: BookmarkIcon,
				run: () => {
					if (isNavigableHash(view.hash, ROUTES)) window.location.hash = view.hash.replace(/^#/, "");
				},
			});
		}

		out.push({
			id: "disconnect",
			label: "Disconnect",
			group: "Account",
			icon: LogoutIcon,
			run: onDisconnect,
		});

		const trimmedQuery = query.trim();
		if (RAY_ID_RE.test(trimmedQuery)) {
			out.push({
				id: "ray:trace",
				label: `Trace Ray ID "${trimmedQuery}"`,
				group: "Actions",
				icon: SearchIcon,
				run: () => {
					window.location.hash = `/request?ray=${encodeURIComponent(trimmedQuery)}`;
				},
			});
		}

		return out;
	}, [
		route,
		accounts,
		accountId,
		onSwitchAccount,
		theme,
		onSetTheme,
		collapsed,
		onToggleCollapsed,
		showRefresh,
		onRefresh,
		refreshing,
		onSaveView,
		views,
		onDisconnect,
		onNavigate,
		query,
	]);

	const filtered = useMemo(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			const recent = readRecent();
			const byId = new Map(commands.map((c) => [c.id, c] as const));
			const head = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
			const headIds = new Set(head.map((c) => c.id));
			return [...head, ...commands.filter((c) => !headIds.has(c.id))].map((c) => ({ command: c, ranges: [] as [number, number][] }));
		}
		return commands
			.map((c) => ({ command: c, match: fuzzyMatch(`${c.label} ${c.keywords ?? ""}`, trimmed) }))
			.filter((x): x is { command: Command; match: { score: number; ranges: [number, number][] } } => x.match !== null)
			.sort((a, b) => b.match.score - a.match.score)
			.map((x) => ({ command: x.command, ranges: x.match.ranges }));
	}, [commands, query]);

	function execute(command: Command) {
		if (command.id !== "ray:trace") pushRecent(command.id);
		onOpenChange(false);
		command.run();
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Home") {
			e.preventDefault();
			setActiveIndex(0);
		} else if (e.key === "End") {
			e.preventDefault();
			setActiveIndex(filtered.length - 1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const item = filtered[activeIndex];
			if (item) execute(item.command);
		}
	}

	useEffect(() => {
		const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
		// jsdom (tests) has no scrollIntoView at all; real browsers always do.
		el?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[15vh]">
			<button type="button" aria-label="Close command palette" className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				className="relative flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
			>
				<div className="relative border-b border-zinc-200 dark:border-zinc-800">
					<SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						role="combobox"
						aria-expanded={open}
						aria-controls="command-palette-listbox"
						aria-activedescendant={filtered[activeIndex] ? `command-palette-option-${activeIndex}` : undefined}
						aria-autocomplete="list"
						aria-label="Type a command or search"
						placeholder="Type a command or search…"
						autoComplete="off"
						spellCheck={false}
						className="w-full bg-transparent py-3 pl-9 pr-3 text-sm outline-none"
					/>
				</div>
				<div ref={listRef} id="command-palette-listbox" role="listbox" aria-label="Commands" className="flex-1 overflow-y-auto p-1.5">
					{filtered.length === 0 && (
						<div className="px-3 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No matching commands.</div>
					)}
					{filtered.map(({ command, ranges }, index) => {
						const showGroupHeading = index === 0 || filtered[index - 1].command.group !== command.group;
						const Icon = command.icon;
						return (
							<div key={command.id}>
								{showGroupHeading && (
									<div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 first:pt-1 dark:text-zinc-500">
										{command.group}
									</div>
								)}
								<div
									id={`command-palette-option-${index}`}
									data-index={index}
									role="option"
									aria-selected={index === activeIndex}
									onMouseEnter={() => setActiveIndex(index)}
									onClick={() => execute(command)}
									className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${
										index === activeIndex
											? "bg-cf/15 text-cf"
											: "text-zinc-700 dark:text-zinc-300"
									}`}
								>
									{Icon && <Icon size={15} />}
									<span className="flex-1 truncate">
										<Highlighted text={command.label} ranges={ranges} />
									</span>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
