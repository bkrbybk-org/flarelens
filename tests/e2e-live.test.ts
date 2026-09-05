import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * End-to-end cover against the deployed Worker: real Cloudflare Access, real bound token, real
 * Cloudflare API. Nothing is mocked.
 *
 * Opt-in, because it costs real API quota against a live account and depends on credentials
 * that only exist on an operator's machine:
 *
 *   FLARELENS_E2E=1 npx vitest run tests/e2e-live.test.ts
 *
 * Credentials come from the gitignored .dev.vars (an Access service token that the app's Access
 * policy admits). Override the target with FLARELENS_E2E_URL. The values are read into request
 * headers and never asserted on, logged, or included in failure output.
 */

const BASE = process.env.FLARELENS_E2E_URL || "https://flarelens.example.com";
const ACCOUNT = process.env.FLARELENS_E2E_ACCOUNT || "11111111111111111111111111111111";
const UNLISTED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function serviceToken(): { id: string; secret: string } | null {
	if (process.env.FLARELENS_E2E !== "1") return null;
	const fromEnv = { id: process.env.CF_ACCESS_CLIENT_ID || "", secret: process.env.CF_ACCESS_CLIENT_SECRET || "" };
	if (fromEnv.id && fromEnv.secret) return fromEnv;
	try {
		const raw = readFileSync(join(import.meta.dirname, "..", ".dev.vars"), "utf8");
		const read = (key: string) => raw.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || "";
		const id = read("CF_ACCESS_CLIENT_ID");
		const secret = read("CF_ACCESS_CLIENT_SECRET");
		return id && secret ? { id, secret } : null;
	} catch {
		return null;
	}
}

const creds = serviceToken();

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
	"CF-Access-Client-Id": creds?.id ?? "",
	"CF-Access-Client-Secret": creds?.secret ?? "",
	...extra,
});

const getJson = async (path: string) => {
	const res = await fetch(`${BASE}${path}`, { headers: authed() });
	return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
};

const postJson = async (path: string, body: unknown) => {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: authed({ "Content-Type": "application/json" }),
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe.skipIf(!creds)("E2E: deployed worker behind Cloudflare Access", () => {
	it("serves /health to an authenticated service token", async () => {
		const res = await getJson("/health");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: "ok" });
	}, 30_000);

	it("redirects an unauthenticated caller to the Access login", async () => {
		const res = await fetch(`${BASE}/health`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("cloudflareaccess.com");
	}, 30_000);

	it("reports server mode and offers only allowlisted accounts", async () => {
		const { status, body } = await getJson("/api/config");
		expect(status).toBe(200);
		const result = body.result as { mode: string; accounts: { id: string }[] };
		expect(result.mode).toBe("server");
		expect(result.accounts.map((a) => a.id)).toContain(ACCOUNT);
	}, 30_000);

	it("never includes a credential in the bootstrap payload", async () => {
		const res = await fetch(`${BASE}/api/config`, { headers: authed() });
		const text = await res.text();
		// A Cloudflare API token is 40 chars of [A-Za-z0-9_-]; the account list has nothing
		// anywhere near that shape.
		expect(text).not.toMatch(/[A-Za-z0-9_-]{40,}/);
	}, 30_000);

	it("serves Zero Trust data under the bound token, with no Authorization header sent", async () => {
		const { status, body } = await getJson(`/api/data?account_id=${ACCOUNT}`);
		expect(status).toBe(200);
		const result = body.result as { apps: unknown[]; idps: unknown[] };
		expect(Array.isArray(result.apps)).toBe(true);
		expect(Array.isArray(result.idps)).toBe(true);
	}, 60_000);

	it("lists zones for the allowlisted account", async () => {
		const { status, body } = await getJson(`/api/zones?account_id=${ACCOUNT}`);
		expect(status).toBe(200);
		expect((body.result as unknown[]).length).toBeGreaterThan(0);
	}, 30_000);

	it("refuses an account outside the deployment allowlist", async () => {
		const { status, body } = await getJson(`/api/zones?account_id=${UNLISTED}`);
		expect(status).toBe(403);
		expect((body.errors as { message: string }[])[0].message).toMatch(/not available/i);
	}, 30_000);

	it("returns AI Security telemetry for the window", async () => {
		const { status, body } = await postJson("/api/ai-security/analyze", { accountId: ACCOUNT, range: "24h" });
		expect(status).toBe(200);
		const result = body.result as { window: { key: string }; zones: unknown[]; data: unknown };
		expect(result.window.key).toBe("24h");
		expect(Array.isArray(result.zones)).toBe(true);
		expect(result.data).toBeTruthy();
	}, 120_000);

	it("returns WAF events with diagnostics", async () => {
		const { status, body } = await postJson("/api/waf/events", { accountId: ACCOUNT, minutes: 60 });
		expect(status).toBe(200);
		expect((body.diagnostics as { scope: string }).scope).toBe("account");
	}, 120_000);

	it("does not let a caller-supplied bad token fall back to the bound one", async () => {
		// A 200 here would mean the deployment silently upgraded a bad credential.
		const res = await fetch(`${BASE}/api/accounts`, {
			headers: authed({ Authorization: "Bearer definitely-not-a-real-token" }),
		});
		expect(res.status).not.toBe(200);
	}, 30_000);

	it("marks API responses no-store and keeps the CSP strict", async () => {
		const res = await fetch(`${BASE}/api/config`, { headers: authed() });
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	}, 30_000);
});

describe.skipIf(creds)("E2E suite", () => {
	it("is skipped without FLARELENS_E2E=1 and Access service-token credentials", () => {
		expect(creds).toBeNull();
	});
});
