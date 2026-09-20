// Bootstraps Swagger UI on /docs. A separate file, not an inline <script>, because the page is
// served under `script-src 'self'` — only the style-src exception is relaxed for /docs, and an
// inline bootstrap is exactly what that directive is there to block. Copied into
// web/public/docs/ by scripts/copy-swagger-ui.mjs alongside the vendor bundles.
window.onload = function () {
	window.ui = SwaggerUIBundle({
		url: "/api/openapi.json",
		dom_id: "#swagger-ui",
		presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
		layout: "StandaloneLayout",
	});
};
