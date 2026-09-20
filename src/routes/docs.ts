// ---------------------------------------------------------------------------
// API documentation: the OpenAPI document itself, and a self-hosted Swagger UI over it.

import { resolveAuth } from "../lib/auth";
import { buildOpenApiDocument } from "../openapi";
import type { App } from "../env";

/** Static fallback when the deployment has no CF_VERSION_METADATA binding (e.g. local dev). */
const FALLBACK_VERSION = "0.0.0-dev";

function unauthenticatedHtml(message: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Flarelens API docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1.5em; color: #18181b;">
<h1 style="font-size: 1.1em;">401 — ${message}</h1>
<p>Reach this page either by browsing it while signed in to a Cloudflare Access session, or by
fetching <code>/api/openapi.json</code> directly with <code>Authorization: Bearer &lt;your Cloudflare API token&gt;</code>.</p>
</body>
</html>`;
}

function swaggerUiHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Flarelens API docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/docs/swagger-ui.css" />
<style>
  body { margin: 0; background: #fafafa; }
  #flarelens-quota-warning {
    font: 13px/1.4 -apple-system, system-ui, sans-serif;
    background: #fef3c7;
    color: #78350f;
    padding: 0.6em 1em;
    border-bottom: 1px solid #fbbf24;
  }
  #flarelens-quota-warning strong { font-weight: 600; }
</style>
</head>
<body>
<div id="flarelens-quota-warning">
  <strong>Heads up:</strong> "Try it out" sends real requests against the connected Cloudflare account and spends real Cloudflare API quota. It is not a sandbox.
</div>
<div id="swagger-ui"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/swagger-ui-standalone-preset.js"></script>
<script src="/docs/init.js"></script>
</body>
</html>`;
}

export function registerDocsRoutes(app: App): void {
	app.get("/api/openapi.json", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.json({ success: false, errors: [{ message: auth.message }] }, auth.status);
		}
		const version = c.env.CF_VERSION_METADATA?.id || FALLBACK_VERSION;
		// The origin the caller reached, so the document is usable by tools that never see this
		// server themselves (API Shield, Postman, a client generator).
		const serverUrl = new URL(c.req.url).origin;
		return c.json(buildOpenApiDocument({ version, serverUrl }));
	});

	app.get("/docs", async (c) => {
		const auth = await resolveAuth(c.req.raw, c.env);
		if (!auth.ok) {
			return c.html(unauthenticatedHtml(auth.message), auth.status);
		}
		return c.html(swaggerUiHtml());
	});
}
