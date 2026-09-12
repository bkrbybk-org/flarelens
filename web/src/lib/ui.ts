/**
 * Shared UI tokens.
 *
 * Before this module every page carried its own copy of the same class strings — nine identical
 * `CARD` constants, five identical `StatCard` components, two sizes of error banner chosen at
 * random. New pages inherited whichever page the author happened to copy, so the drift was
 * structural rather than careless. Anything that appears on more than one page belongs here.
 *
 * Rules for adding a token:
 *   - It must describe a *role* ("secondary button"), never an appearance ("small grey button").
 *   - Two tokens for one role is a bug, not a choice. Pick one and change the minority.
 *   - Colours always carry their dark-mode pair. A light-only `text-zinc-400` is 2.8:1 on white,
 *     which fails WCAG AA; `MUTED` is the only muted-text token for that reason.
 */

/**
 * Keyboard focus indicator.
 *
 * `outline-none` on its own leaves keyboard users with nothing but a border-colour shift, which is
 * invisible against most of this app's surfaces. Every interactive element gets this instead.
 * `focus-visible` rather than `focus` so a mouse click does not leave a ring behind.
 */
export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cf/40";

/** The standard panel. Padded; use `CARD_FLUSH` when the content supplies its own padding. */
export const CARD = "rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

/** A panel whose children draw to the edges — tables, and cards with their own header bar. */
export const CARD_FLUSH = "rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900";

/** Secondary text: labels, hints, timestamps. Never `text-zinc-400` alone. */
export const MUTED = "text-zinc-500 dark:text-zinc-400";

/** A heading inside a page — the page's own title lives in the top bar, so these are all h2/h3. */
export const SECTION_TITLE = "text-sm font-semibold";

/** A section heading that sits on a card's own header bar rather than above the card. */
export const CARD_HEADER = "border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800";

/**
 * Page-level banners.
 *
 * Sized to match `CARD` — same radius, same padding — because they sit in the same vertical stack
 * as the page's cards and a different rhythm reads as a different app.
 */
export const ALERT_ERROR =
	"rounded-xl border border-red-300/50 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400";
export const ALERT_WARN =
	"rounded-xl border border-amber-300/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-400";

/** The one high-emphasis action on a surface. Reserved for the top bar's Sync. */
export const BTN_PRIMARY = `flex items-center gap-2 rounded-lg bg-cf px-3 py-1.5 text-sm font-medium text-white transition hover:bg-cf-hover disabled:opacity-50 ${FOCUS_RING}`;

/** Everything else that is a button: pagination, export, column pickers, filters. */
export const BTN_SECONDARY = `rounded-lg border border-zinc-200 px-3 py-1.5 text-sm transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`;

/** A secondary button competing for space in a toolbar. Same role, one step down in size. */
export const BTN_SECONDARY_SM = `flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 ${FOCUS_RING}`;

/** A bare icon button: theme toggle, sign out, drawer close. */
export const BTN_ICON = `rounded-lg border border-zinc-200 p-2 text-zinc-500 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 ${FOCUS_RING}`;

/** Text inputs and selects. `SEARCH_INPUT` adds room for the magnifier icon the pages overlay. */
export const INPUT = `rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`;
export const SEARCH_INPUT = `w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`;
export const SELECT = `rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-cf dark:border-zinc-700 dark:bg-zinc-900 ${FOCUS_RING}`;

/**
 * A status pill: severity, decision, rule action, "Disabled".
 *
 * Geometry only — the caller supplies the tone. Tones follow the `/15` alpha convention
 * (`bg-emerald-500/15 text-emerald-600 dark:text-emerald-400`) so a pill sits on either theme's
 * surface without a second colour definition.
 */
export const BADGE = "rounded-full px-2 py-0.5 text-xs font-semibold";

/** The neutral tone, for a pill that reports a state rather than a severity. */
export const BADGE_NEUTRAL = `${BADGE} bg-zinc-500/15 text-zinc-600 dark:text-zinc-400`;

/**
 * Keyboard focus on a clickable table row.
 *
 * A row used to mark focus by shading itself zinc-50, which against a white table is about
 * 1.03:1 — technically a change, practically invisible. A ring cannot be used here: rings are
 * box-shadows, and a `<tr>` under `border-collapse` does not paint them. An outline does, and
 * a negative offset keeps it inside the row rather than straddling the row above.
 */
export const FOCUS_ROW =
	"focus-visible:outline-2 focus-visible:outline-cf focus-visible:-outline-offset-2 focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800/40";
