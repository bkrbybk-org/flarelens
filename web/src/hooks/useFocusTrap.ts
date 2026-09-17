import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab/Shift+Tab focus cycling inside `containerRef` while `active`, restores focus to
 * whatever had it beforehand once `active` goes false again, and calls `onEscape` on Escape.
 *
 * Shared by the command palette and the name dialog — both are modal overlays with the same
 * keyboard contract, and a second hand-rolled copy of this is exactly the kind of drift
 * [web/src/lib/ui.ts](../lib/ui.ts) exists to prevent for styling.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void): void {
	useEffect(() => {
		if (!active) return;
		const previouslyFocused = document.activeElement as HTMLElement | null;

		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onEscape();
				return;
			}
			if (e.key !== "Tab") return;
			const container = containerRef.current;
			if (!container) return;
			const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(el) => el.offsetParent !== null || el === document.activeElement,
			);
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}

		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			previouslyFocused?.focus?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);
}
