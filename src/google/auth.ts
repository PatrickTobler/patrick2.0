import { log } from "../log.ts";

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const REFRESH_MARGIN_MS = 60_000;

export const DEFAULT_ACCOUNT = "primary";

// `primary` lives on plain GOOGLE_REFRESH_TOKEN (preserves the original single-account
// setup). Additional accounts use GOOGLE_REFRESH_TOKEN_<UPPER_NAME>, e.g.
// GOOGLE_REFRESH_TOKEN_PERSONAL.
function envKeyFor(account: string): string {
	const a = account.trim().toLowerCase();
	if (a === DEFAULT_ACCOUNT) return "GOOGLE_REFRESH_TOKEN";
	return `GOOGLE_REFRESH_TOKEN_${a.toUpperCase()}`;
}

function refreshTokenFor(account: string): string | undefined {
	return process.env[envKeyFor(account)]?.trim() || undefined;
}

export async function getGoogleAccessToken(account: string = DEFAULT_ACCOUNT): Promise<string> {
	const now = Date.now();
	const key = account.toLowerCase();
	const cached = cache.get(key);
	if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.accessToken;

	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	const refreshToken = refreshTokenFor(account);
	if (!clientId || !clientSecret || !refreshToken) {
		throw new Error(
			`Google OAuth not configured for account "${account}" — need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ${envKeyFor(account)}.`,
		);
	}

	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		log.error({ status: res.status, body, account }, "google token refresh failed");
		throw new Error(`Google token refresh failed for ${account}: ${res.status}`);
	}

	const json = (await res.json()) as { access_token: string; expires_in: number };
	cache.set(key, {
		accessToken: json.access_token,
		expiresAt: now + json.expires_in * 1000,
	});
	return json.access_token;
}

export function listGoogleAccounts(): string[] {
	const accounts = new Set<string>();
	if (process.env.GOOGLE_REFRESH_TOKEN) accounts.add(DEFAULT_ACCOUNT);
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("GOOGLE_REFRESH_TOKEN_")) {
			const name = k.replace("GOOGLE_REFRESH_TOKEN_", "").toLowerCase();
			if (name && process.env[k]) accounts.add(name);
		}
	}
	return Array.from(accounts);
}

export function googleConfigured(): boolean {
	return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && listGoogleAccounts().length > 0);
}
