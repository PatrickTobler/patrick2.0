import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { ensureVault, pull, vaultDir } from "./sync.ts";

export const PROFILE_PATH = "patrick2.0/profile.md";
const MAX_PROFILE_BYTES = 6000;

let cached: { mtime: number; content: string } | null = null;
let lastPullAt = 0;
const PULL_TTL_MS = 60_000;

/** Read the core profile from the vault. Pulls fresh from git at most once per minute. */
export async function loadProfile(): Promise<string | null> {
	try {
		await ensureVault();
		if (Date.now() - lastPullAt > PULL_TTL_MS) {
			await pull();
			lastPullAt = Date.now();
			cached = null;
		}
		const abs = join(vaultDir(), PROFILE_PATH);
		if (!existsSync(abs)) return null;
		const raw = readFileSync(abs, "utf-8");
		const content = raw.length > MAX_PROFILE_BYTES ? `${raw.slice(0, MAX_PROFILE_BYTES)}\n\n(truncated)` : raw;
		cached = { mtime: Date.now(), content };
		return content;
	} catch (err) {
		log.warn({ err }, "loadProfile failed");
		return cached?.content ?? null;
	}
}
