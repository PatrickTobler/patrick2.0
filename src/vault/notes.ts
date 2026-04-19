import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { commitAndPush, ensureVault, pull, vaultDir } from "./sync.ts";

function safePath(rel: string): string {
	const root = vaultDir();
	const abs = resolve(root, rel);
	if (!abs.startsWith(root + sep) && abs !== root) {
		throw new Error(`Path escapes vault root: ${rel}`);
	}
	return abs;
}

function ensureMd(rel: string): string {
	if (rel.endsWith(".md")) return rel;
	return `${rel}.md`;
}

export interface NoteSummary {
	path: string;
	bytes: number;
	mtime: Date;
}

export async function listNotes(prefix = "", limit = 100): Promise<NoteSummary[]> {
	await pull();
	const root = vaultDir();
	const start = safePath(prefix);
	if (!existsSync(start)) return [];
	const out: NoteSummary[] = [];
	const stack: string[] = [start];
	while (stack.length && out.length < limit) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.startsWith(".")) continue;
			const p = join(dir, e);
			const st = statSync(p);
			if (st.isDirectory()) stack.push(p);
			else if (e.endsWith(".md")) {
				out.push({ path: relative(root, p), bytes: st.size, mtime: st.mtime });
				if (out.length >= limit) break;
			}
		}
	}
	out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return out;
}

export async function readNote(path: string): Promise<string> {
	await pull();
	const abs = safePath(ensureMd(path));
	if (!existsSync(abs)) throw new Error(`Note not found: ${path}`);
	return readFile(abs, "utf-8");
}

export async function writeNote(path: string, content: string, commitMsg?: string): Promise<string> {
	await ensureVault();
	const rel = ensureMd(path);
	const abs = safePath(rel);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf-8");
	await commitAndPush(commitMsg ?? `bot: write ${rel}`);
	return rel;
}

export async function appendNote(path: string, content: string, commitMsg?: string): Promise<string> {
	await pull();
	const rel = ensureMd(path);
	const abs = safePath(rel);
	const existing = existsSync(abs) ? await readFile(abs, "utf-8") : "";
	const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, `${existing}${sep}${content}`, "utf-8");
	await commitAndPush(commitMsg ?? `bot: append to ${rel}`);
	return rel;
}

export interface SearchHit {
	path: string;
	score: number;
	snippet: string;
}

export async function searchNotes(query: string, limit = 10): Promise<SearchHit[]> {
	await pull();
	const root = vaultDir();
	if (!existsSync(root)) return [];
	const needle = query.toLowerCase();
	const hits: SearchHit[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.startsWith(".")) continue;
			const p = join(dir, e);
			const st = statSync(p);
			if (st.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (!e.endsWith(".md")) continue;
			let body: string;
			try {
				body = readFileSync(p, "utf-8");
			} catch {
				continue;
			}
			const lower = body.toLowerCase();
			let score = 0;
			let i = lower.indexOf(needle);
			while (i !== -1) {
				score++;
				if (score > 50) break;
				i = lower.indexOf(needle, i + needle.length);
			}
			if (score === 0 && relative(root, p).toLowerCase().includes(needle)) score = 1;
			if (score === 0) continue;
			const idx = lower.indexOf(needle);
			const start = Math.max(0, idx - 60);
			const end = Math.min(body.length, idx + needle.length + 100);
			const snippet = `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
			hits.push({ path: relative(root, p), score, snippet });
		}
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}
