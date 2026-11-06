import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { storageGet, storageSet } from "../lib/storage";

/**
 * Whether people's names are hidden on screen: on while presenting with "Hide names" ticked, so a
 * booth or a customer meeting never shows a colleague's email. Pages that show people (the AI
 * Gateway users) read it and put a stable alias — User A, User B — in place of each name.
 */
export const HideNamesContext = createContext(false);

export function useHideNames(): boolean {
	return useContext(HideNamesContext);
}

const HIDE_NAMES_KEY = "flarelens_present_hide_names";

/** The presenter's choice, kept in this browser. On unless turned off: a public screen is the safer default. */
export function useHideNamesPreference() {
	const [hide, setHide] = useState(() => storageGet("local", HIDE_NAMES_KEY) !== "0");
	const choose = useCallback((next: boolean) => {
		setHide(next);
		storageSet("local", HIDE_NAMES_KEY, next ? "1" : "0");
	}, []);
	return [hide, choose] as const;
}

/** A, B, … Z, AA, AB, …: the n-th alias letter, from 0. */
export function aliasLetters(n: number): string {
	let out = "";
	let i = n;
	do {
		out = String.fromCharCode(65 + (i % 26)) + out;
		i = Math.floor(i / 26) - 1;
	} while (i >= 0);
	return out;
}

const EMAIL_SOURCE = "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+";
const HAS_EMAIL = new RegExp(EMAIL_SOURCE);
/** Where text reaches a viewer outside a text node. A placeholder is example text, not anyone's address. */
const MASKED_ATTRIBUTES = ["title", "aria-label", "alt"];
/** What a person typed stays as typed: masking it would change what they are searching for. */
const SKIPPED_PARENTS = new Set(["INPUT", "TEXTAREA", "SCRIPT", "STYLE"]);

/**
 * While on, every email address on screen shows as a stable alias (Person A, Person B…), on any
 * page: the audit log's actors, a policy's `identity.email == "…"`, a DNS record, and whatever a
 * future page adds. It works on what was rendered rather than in each component, and a mutation
 * observer runs before the browser paints, so an address never reaches the screen. Leaving puts
 * the originals back. Exports and copies of the data are untouched, and only email-shaped text is
 * recognised: a person named some other way needs the page's own alias, as the AI Gateway has.
 */
export function useMaskEmails(active: boolean): void {
	const aliases = useRef(new Map<string, string>());
	useLayoutEffect(() => {
		if (!active) return;
		const known = aliases.current;
		const mask = (text: string) =>
			text.replace(new RegExp(EMAIL_SOURCE, "g"), (email) => {
				const key = email.toLowerCase();
				if (!known.has(key)) known.set(key, `Person ${aliasLetters(known.size)}`);
				return known.get(key)!;
			});
		const texts = new Map<Text, { original: string; masked: string }>();
		const attributes = new Map<Element, Map<string, { original: string; masked: string }>>();
		const maskText = (node: Text) => {
			const value = node.nodeValue ?? "";
			if (!HAS_EMAIL.test(value) || SKIPPED_PARENTS.has(node.parentElement?.tagName ?? "")) return;
			const masked = mask(value);
			texts.set(node, { original: value, masked });
			node.nodeValue = masked;
		};
		const maskAttribute = (element: Element, name: string) => {
			const value = element.getAttribute(name);
			if (!value || !HAS_EMAIL.test(value)) return;
			const masked = mask(value);
			const held = attributes.get(element) ?? new Map<string, { original: string; masked: string }>();
			held.set(name, { original: value, masked });
			attributes.set(element, held);
			element.setAttribute(name, masked);
		};
		const sweep = (root: Node) => {
			if (root.nodeType === Node.TEXT_NODE) return maskText(root as Text);
			if (root.nodeType !== Node.ELEMENT_NODE) return;
			const element = root as Element;
			for (const name of MASKED_ATTRIBUTES) maskAttribute(element, name);
			for (const child of element.querySelectorAll("*")) for (const name of MASKED_ATTRIBUTES) maskAttribute(child, name);
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) maskText(node as Text);
		};
		sweep(document.body);
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "characterData") maskText(record.target as Text);
				else if (record.type === "attributes") maskAttribute(record.target as Element, record.attributeName!);
				else record.addedNodes.forEach(sweep);
			}
		});
		observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: MASKED_ATTRIBUTES });
		return () => {
			observer.disconnect();
			// Only what still shows the alias goes back: anything React has rewritten since is already right.
			for (const [node, { original, masked }] of texts) if (node.nodeValue === masked) node.nodeValue = original;
			for (const [element, held] of attributes) for (const [name, { original, masked }] of held) if (element.getAttribute(name) === masked) element.setAttribute(name, original);
		};
	}, [active]);
}
