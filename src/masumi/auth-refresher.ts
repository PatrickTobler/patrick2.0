import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

const CLIENT_ID = "masumi-spacetime-cli";
const TOKEN_URL = "https://app.masumi.network/api/auth/oauth2/token";
const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 min — ahead of the 60-min expiry
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh if <10 min left

function secretsPath(): string {
	const home = process.env.HOME ?? "/data/home";
	return join(home, ".config/masumi-agent-messenger/cli/secrets.json");
}

interface OidcEntry {
	idToken: string;
	accessToken: string;
	refreshToken: string;
	grantedScopes: string[];
	expiresAt: number;
	createdAt: number;
}

interface SecretsOuter {
	version: number;
	entries: Record<string, string>;
}

export async function refreshMasumiTokenIfNeeded(
	force = false,
): Promise<{ ok: boolean; reason?: string; msUntilExpiry?: number }> {
	const path = secretsPath();
	if (!existsSync(path)) return { ok: false, reason: "secrets.json not found (masumi CLI not yet authed)" };

	let outer: SecretsOuter;
	try {
		outer = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return { ok: false, reason: `cannot parse secrets.json: ${(err as Error).message}` };
	}

	const oidcStr = outer.entries?.["default:oidc"];
	if (!oidcStr) return { ok: false, reason: "no default:oidc entry — authenticate once via device-code flow" };

	let oidc: OidcEntry;
	try {
		oidc = JSON.parse(oidcStr);
	} catch (err) {
		return { ok: false, reason: `cannot parse OIDC entry: ${(err as Error).message}` };
	}

	const msUntilExpiry = oidc.expiresAt - Date.now();
	if (!force && msUntilExpiry > REFRESH_MARGIN_MS) {
		return { ok: true, reason: "still valid, skipped", msUntilExpiry };
	}

	if (!oidc.refreshToken) return { ok: false, reason: "no refresh token in OIDC entry" };

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: oidc.refreshToken,
			client_id: CLIENT_ID,
		}).toString(),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		return { ok: false, reason: `refresh HTTP ${res.status}: ${body.slice(0, 200)}` };
	}

	const body = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		id_token?: string;
	};

	const now = Date.now();
	const updated: OidcEntry = {
		idToken: body.id_token ?? oidc.idToken,
		accessToken: body.access_token,
		refreshToken: body.refresh_token ?? oidc.refreshToken,
		grantedScopes: oidc.grantedScopes,
		expiresAt: now + body.expires_in * 1000,
		createdAt: now,
	};

	outer.entries["default:oidc"] = JSON.stringify(updated);
	writeFileSync(path, JSON.stringify(outer, null, 2), "utf-8");

	return { ok: true, msUntilExpiry: body.expires_in * 1000 };
}

let timer: NodeJS.Timeout | null = null;

export function startMasumiTokenRefresher(): void {
	if (timer) return;
	const run = async () => {
		try {
			const r = await refreshMasumiTokenIfNeeded();
			if (r.ok) {
				log.info({ msUntilExpiry: r.msUntilExpiry, reason: r.reason }, "masumi token check");
			} else {
				log.warn({ reason: r.reason }, "masumi token refresh skipped/failed");
			}
		} catch (err) {
			log.error({ err }, "masumi token refresher crashed");
		}
	};
	// Run once at boot, then on interval
	void run();
	timer = setInterval(() => void run(), REFRESH_INTERVAL_MS);
}

export function stopMasumiTokenRefresher(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
