import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

let accessCache: CachedToken | null = null;
const REFRESH_MARGIN_MS = 60_000;

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

// WHOOP rotates refresh tokens on every use — the new one comes back in the
// /oauth/oauth2/token response, and the OLD one is invalidated immediately.
// We must persist the new refresh token between processes, otherwise the
// next process boots with a stale env-var refresh token and every API call
// fails. We write to the Railway volume (HOME=/data/home in prod) so the
// rotation survives restarts.
function tokenFilePath(): string {
	const home = process.env.HOME ?? "/data/home";
	return join(home, ".whoop", "refresh_token.json");
}

interface PersistedRefresh {
	refreshToken: string;
	rotatedAt: number; // ms epoch
}

function readPersistedRefresh(): string | null {
	try {
		const p = tokenFilePath();
		if (!existsSync(p)) return null;
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as PersistedRefresh;
		return parsed.refreshToken ?? null;
	} catch (err) {
		log.warn({ err }, "whoop persisted refresh token unreadable, falling back to env");
		return null;
	}
}

function writePersistedRefresh(refreshToken: string): void {
	try {
		const p = tokenFilePath();
		mkdirSync(dirname(p), { recursive: true });
		const tmp = `${p}.tmp`;
		const body: PersistedRefresh = { refreshToken, rotatedAt: Date.now() };
		writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
		renameSync(tmp, p);
	} catch (err) {
		log.warn({ err }, "whoop refresh token persistence failed — next process boot may fail to auth");
	}
}

function currentRefreshToken(): string | undefined {
	const persisted = readPersistedRefresh();
	if (persisted) return persisted;
	const fromEnv = process.env.WHOOP_REFRESH_TOKEN?.trim();
	return fromEnv || undefined;
}

export async function getWhoopAccessToken(): Promise<string> {
	const now = Date.now();
	if (accessCache && accessCache.expiresAt - REFRESH_MARGIN_MS > now) return accessCache.accessToken;

	const clientId = process.env.WHOOP_CLIENT_ID;
	const clientSecret = process.env.WHOOP_CLIENT_SECRET;
	const refreshToken = currentRefreshToken();
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
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		log.error({ status: res.status, body: body.slice(0, 300) }, "whoop token refresh failed");
		throw new Error(`WHOOP token refresh failed: ${res.status}`);
	}

	const json = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
	if (json.refresh_token && json.refresh_token !== refreshToken) {
		// WHOOP rotated the refresh token. Persist immediately so the next
		// process boot uses the new one instead of the stale env var.
		writePersistedRefresh(json.refresh_token);
	}
	accessCache = {
		accessToken: json.access_token,
		expiresAt: now + json.expires_in * 1000,
	};
	return accessCache.accessToken;
}

export function whoopConfigured(): boolean {
	return !!(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET && currentRefreshToken());
}
