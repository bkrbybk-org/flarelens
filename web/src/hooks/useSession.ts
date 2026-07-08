import { useCallback, useState } from "react";

const TOKEN_KEY = "cf_api_token";
const ACCOUNT_ID_KEY = "cf_account_id";
const ACCOUNT_NAME_KEY = "cf_account_name";

export interface Session {
	token: string;
	accountId: string;
	accountName: string;
}

function readSession(): Session | null {
	const token = sessionStorage.getItem(TOKEN_KEY);
	const accountId = sessionStorage.getItem(ACCOUNT_ID_KEY);
	if (!token || !accountId) {
		return null;
	}
	return { token, accountId, accountName: sessionStorage.getItem(ACCOUNT_NAME_KEY) || accountId };
}

export function useSession() {
	const [session, setSession] = useState<Session | null>(readSession);

	const connect = useCallback((next: Session) => {
		sessionStorage.setItem(TOKEN_KEY, next.token);
		sessionStorage.setItem(ACCOUNT_ID_KEY, next.accountId);
		sessionStorage.setItem(ACCOUNT_NAME_KEY, next.accountName);
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
