import { Hono } from "hono";
import type { Env } from "./env";
import { SECURITY_HEADERS } from "./http";
import { registerCoreRoutes } from "./routes/core";
import { registerAccessRoutes } from "./routes/access";
import { registerAiSecurityRoutes } from "./routes/ai-security";
import { registerWafRoutes } from "./routes/waf";
import { registerGatewayRoutes } from "./routes/gateway";
import { registerWorkersAiRoutes } from "./routes/workers-ai";
import { registerAiGatewayRoutes } from "./routes/ai-gateway";
import { registerRequestTraceRoutes } from "./routes/request-trace";
import { registerTunnelRoutes } from "./routes/tunnels";
import { registerPqcRoutes } from "./routes/pqc";
import { registerZoneHealthRoutes } from "./routes/zone-health";
import { registerDnsRoutes } from "./routes/dns";
import { registerBotsRoutes } from "./routes/bots";
import { registerAccessUsageRoutes } from "./routes/access-usage";
import { registerWorkersRoutes } from "./routes/workers";
import { registerCacheRoutes } from "./routes/cache";

const app = new Hono<{ Bindings: Env }>();

// Security headers on every response; API responses are token-derived, never cacheable.
// Asset responses arrive with immutable headers, so rewrap before mutating.
app.use("*", async (c, next) => {
	await next();
	const res = new Response(c.res.body, c.res);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		res.headers.set(key, value);
	}
	if (c.req.path.startsWith("/api/")) {
		res.headers.set("Cache-Control", "no-store");
	}
	c.res = res;
});

// Route registration order is preserved from the pre-split index.ts; the asset catch-all must
// stay last.
registerCoreRoutes(app);
registerAccessRoutes(app);
registerAiSecurityRoutes(app);
registerWafRoutes(app);
registerGatewayRoutes(app);
registerWorkersAiRoutes(app);
registerAiGatewayRoutes(app);
registerRequestTraceRoutes(app);
registerTunnelRoutes(app);
registerPqcRoutes(app);
registerZoneHealthRoutes(app);
registerDnsRoutes(app);
registerBotsRoutes(app);
registerAccessUsageRoutes(app);
registerWorkersRoutes(app);
registerCacheRoutes(app);

// Static assets fallback
app.all("*", async (c) => {
	const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
	if (assetResponse.status === 404) {
		return new Response("Not Found", { status: 404 });
	}
	return assetResponse;
});

export default app;
