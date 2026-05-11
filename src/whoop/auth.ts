import { log } from "../log.ts";

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

let cache: CachedToken | null = null;
const REFRESH_MARGIN_MS = 60_000;

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

export async function getWhoopAccessToken(): Promise<string> {
	const now = Date.now();
	if (cache && cache.expiresAt - REFRESH_MARGIN_MS > now) return cache.accessToken;

	const clientId = process.env.WHOOP_CLIENT_ID;
	const clientSecret = process.env.WHOOP_CLIENT_SECRET;
	const refreshToken = process.env.WHOOP_REFRESH_TOKEN;
	if (!clientId || !clientSecret || !refreshToken) {
		throw new Error("WHOOP OAuth not configured — need WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, and WHOOP_REFRESH_TOKEN.");
	}

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			scope: "offline",
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		log.error({ status: res.status, body: body.slice(0, 300) }, "whoop token refresh failed");
		throw new Error(`WHOOP token refresh failed: ${res.status}`);
	}

	const json = (await res.json()) as { access_token: string; expires_in: number };
	cache = {
		accessToken: json.access_token,
		expiresAt: now + json.expires_in * 1000,
	};
	return cache.accessToken;
}

export function whoopConfigured(): boolean {
	return !!(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET && process.env.WHOOP_REFRESH_TOKEN);
}
