import { useCallback, useState } from "react";

const TOKEN_KEY = "cf_api_token";
const ACCOUNT_ID_KEY = "cf_account_id";
const ACCOUNT_NAME_KEY = "cf_account_name";

/**
 * How this browser session is authenticated.
 *
 * byot   — the operator pasted a Cloudflare API token; it lives in sessionStorage and rides on
 *          every request as `Authorization: Bearer`.
 * server — the worker holds the token and Cloudflare Access authenticates the operator. The
 *          browser never sees a credential, so `token` is empty and no header is sent.
 */
export type SessionMode = "byot" | "server";

export interface Session {
	/** Empty in server mode: the request carries no Authorization header at all. */
	token: string;
	accountId: string;
	accountName: string;
	mode: SessionMode;
}

function readSession(): Session | null {
	const token = sessionStorage.getItem(TOKEN_KEY);
	const accountId = sessionStorage.getItem(ACCOUNT_ID_KEY);
	if (!token || !accountId) {
		return null;
	}
	return {
		token,
		accountId,
		accountName: sessionStorage.getItem(ACCOUNT_NAME_KEY) || accountId,
		mode: "byot",
	};
}

export function useSession() {
	const [session, setSession] = useState<Session | null>(readSession);

	const connect = useCallback((next: Session) => {
		// A server-mode session is derived from /api/config on every load and must not outlive
		// the Access session that produced it, so it is never written to storage.
		if (next.mode === "byot") {
			sessionStorage.setItem(TOKEN_KEY, next.token);
			sessionStorage.setItem(ACCOUNT_ID_KEY, next.accountId);
			sessionStorage.setItem(ACCOUNT_NAME_KEY, next.accountName);
		}
		setSession(next);
	}, []);

	const disconnect = useCallback(() => {
		sessionStorage.removeItem(TOKEN_KEY);
		sessionStorage.removeItem(ACCOUNT_ID_KEY);
		sessionStorage.removeItem(ACCOUNT_NAME_KEY);
		setSession(null);
	}, []);

	return { session, connect, disconnect };
}
