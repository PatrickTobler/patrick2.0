import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { log } from "../log.ts";

const exec = promisify(execFile);

const VAULT_REPO = process.env.VAULT_REPO ?? "https://github.com/PatrickTobler/patrick-vault.git";
const VAULT_DIR = resolve(process.env.VAULT_DIR ?? "/data/vault");
const COMMIT_AUTHOR_NAME = "patrick2.0";
const COMMIT_AUTHOR_EMAIL = "patrick2.0@noreply.patrick2.0";

let initialized = false;

function authedRepoUrl(): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) return VAULT_REPO;
	if (!VAULT_REPO.startsWith("https://github.com/")) return VAULT_REPO;
	return VAULT_REPO.replace("https://", `https://x-access-token:${token}@`);
}

async function git(args: string[], cwd: string = VAULT_DIR): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
			GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
			GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
			GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
		},
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}

export async function ensureVault(): Promise<string> {
	if (initialized && existsSync(join(VAULT_DIR, ".git"))) return VAULT_DIR;
	if (!existsSync(VAULT_DIR)) {
		await mkdir(dirname(VAULT_DIR), { recursive: true });
		log.info({ url: VAULT_REPO, dir: VAULT_DIR }, "cloning vault");
		await exec("git", ["clone", authedRepoUrl(), VAULT_DIR], { maxBuffer: 32 * 1024 * 1024 });
	} else if (!existsSync(join(VAULT_DIR, ".git"))) {
		throw new Error(`${VAULT_DIR} exists but is not a git repo`);
	}
	// Make sure remote URL has the auth token (in case env was changed)
	await git(["remote", "set-url", "origin", authedRepoUrl()]);
	initialized = true;
	return VAULT_DIR;
}

export async function pull(): Promise<void> {
	await ensureVault();
	try {
		await git(["pull", "--rebase", "--autostash"]);
	} catch (err) {
		log.warn({ err }, "vault pull failed (continuing with stale copy)");
	}
}

export async function commitAndPush(message: string): Promise<boolean> {
	await ensureVault();
	const status = await git(["status", "--porcelain"]);
	if (status.trim() === "") return false;
	await git(["add", "-A"]);
	try {
		await git(["commit", "-m", message]);
	} catch (err) {
		log.warn({ err }, "vault commit failed");
		return false;
	}
	try {
		await git(["pull", "--rebase", "--autostash"]);
		await git(["push"]);
		return true;
	} catch (err) {
		log.error({ err }, "vault push failed");
		return false;
	}
}

export function vaultDir(): string {
	return VAULT_DIR;
}
