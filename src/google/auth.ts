import { log } from "../log.ts";

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

let cache: CachedToken | null = null;
const REFRESH_MARGIN_MS = 60_000;

export async function getGoogleAccessToken(): Promise<string> {
	const now = Date.now();
	if (cache && cache.expiresAt - REFRESH_MARGIN_MS > now) return cache.accessToken;

	const clientId = process.env.GOOGLE_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
	if (!clientId || !clientSecret || !refreshToken) {
		throw new Error("Google OAuth not configured (GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN missing)");
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
		log.error({ status: res.status, body }, "google token refresh failed");
		throw new Error(`Google token refresh failed: ${res.status}`);
	}

	const json = (await res.json()) as { access_token: string; expires_in: number };
	cache = {
		accessToken: json.access_token,
		expiresAt: now + json.expires_in * 1000,
	};
	return cache.accessToken;
}

export function googleConfigured(): boolean {
	return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}
