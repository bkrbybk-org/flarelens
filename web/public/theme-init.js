// Runs before React mounts, blocking, so the page never paints the wrong theme and then flips.
// Plain script (not a module) because the CSP is `script-src 'self'` with no `'unsafe-inline'`,
// so this has to be a same-origin file rather than an inline <script> in index.html.
//
// Mirrors the "system" handling in web/src/hooks/usePrefs.ts: same storage key, same fallback
// to dark when prefs are missing or unreadable (matches index.html's hardcoded `class="dark"`,
// so this never has to remove a class that was never added).
(function () {
	try {
		var raw = localStorage.getItem("cf_zt_prefs");
		var theme = raw ? JSON.parse(raw).theme : "dark";
		var dark;
		if (theme === "light") {
			dark = false;
		} else if (theme === "system") {
			dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
		} else {
			dark = true;
		}
		var root = document.documentElement;
		if (dark) {
			root.classList.add("dark");
		} else {
			root.classList.remove("dark");
		}
		root.style.colorScheme = dark ? "dark" : "light";
	} catch {
		// Storage unavailable or malformed: leave index.html's default `class="dark"` alone.
	}
})();
