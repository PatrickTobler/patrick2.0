import { type Stats, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import YAML from "yaml";
import { log } from "../log.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	source: string;
	disableModelInvocation: boolean;
}

export interface SkillsLoad {
	skills: Skill[];
	warnings: string[];
}

interface Frontmatter {
	name?: string;
	description?: string;
	disableModelInvocation?: boolean;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
	const m = raw.match(FRONTMATTER_RE);
	if (!m || !m[1]) return { fm: {}, body: raw };
	let parsed: Record<string, unknown>;
	try {
		parsed = (YAML.parse(m[1]) as Record<string, unknown>) ?? {};
	} catch {
		return { fm: {}, body: m[2] ?? "" };
	}
	const fm: Frontmatter = {};
	if (typeof parsed.name === "string") fm.name = parsed.name.trim();
	if (typeof parsed.description === "string") fm.description = parsed.description.trim().replace(/\s+/g, " ");
	if (typeof parsed["disable-model-invocation"] === "boolean") {
		fm.disableModelInvocation = parsed["disable-model-invocation"];
	}
	return { fm, body: m[2] ?? "" };
}

function nameValid(name: string, parentDir: string): string | null {
	if (name !== parentDir) return `name "${name}" does not match parent dir "${parentDir}"`;
	if (name.length === 0 || name.length > MAX_NAME_LENGTH) return "name length out of range";
	if (!/^[a-z0-9-]+$/.test(name)) return "name has invalid chars";
	if (name.startsWith("-") || name.endsWith("-")) return "name has leading/trailing hyphen";
	if (name.includes("--")) return "name has consecutive hyphens";
	return null;
}

function readSkillFile(filePath: string, source: string): { skill?: Skill; warning?: string } {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		return { warning: `cannot read ${filePath}: ${(err as Error).message}` };
	}
	const { fm } = parseFrontmatter(raw);
	const parentDir = basename(filePath.endsWith("SKILL.md") ? join(filePath, "..") : filePath).replace(/\.md$/, "");
	const name = fm.name ?? parentDir;
	if (fm.name) {
		const nameErr = nameValid(fm.name, parentDir);
		if (nameErr) return { warning: `${filePath}: ${nameErr}` };
	}
	if (!fm.description) {
		// Skip skills without explicit frontmatter description — auto-deriving from body is unsafe
		// because skills like fal-ai / wise-bank embed credentials in markdown that would leak to the LLM.
		return { warning: `${filePath}: missing 'description' in frontmatter — skipped (add description: to surface)` };
	}
	if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
		return { warning: `${filePath}: description too long (${fm.description.length}/${MAX_DESCRIPTION_LENGTH})` };
	}
	return {
		skill: {
			name,
			description: fm.description,
			filePath,
			source,
			disableModelInvocation: fm.disableModelInvocation === true,
		},
	};
}

function scanDir(dir: string, source: string, warnings: string[], depth = 0): Skill[] {
	if (depth > 4) return [];
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const full = join(dir, entry);
		let stat: Stats;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			const skillFile = join(full, "SKILL.md");
			if (existsSync(skillFile)) {
				const r = readSkillFile(skillFile, source);
				if (r.skill) skills.push(r.skill);
				if (r.warning) warnings.push(r.warning);
				continue;
			}
			skills.push(...scanDir(full, source, warnings, depth + 1));
			continue;
		}
		if (depth === 0 && entry.endsWith(".md") && entry.toUpperCase() !== "SKILL.MD") {
			const r = readSkillFile(full, source);
			if (r.skill) skills.push(r.skill);
			if (r.warning) warnings.push(r.warning);
		}
	}
	return skills;
}

function scanAllDirs(): SkillsLoad {
	const dirs: { path: string; source: string }[] = [
		{ path: join(homedir(), ".pi", "agent", "skills"), source: "pi-user" },
		{ path: join(homedir(), ".claude", "skills"), source: "claude-user" },
		{ path: resolve(process.cwd(), ".pi", "skills"), source: "project" },
	];
	const warnings: string[] = [];
	const seen = new Map<string, Skill>();
	for (const { path, source } of dirs) {
		const found = scanDir(path, source, warnings);
		for (const s of found) {
			if (!seen.has(s.name)) seen.set(s.name, s);
		}
	}
	const skills = Array.from(seen.values());
	if (warnings.length > 0) log.warn({ warnings: warnings.slice(0, 10), count: warnings.length }, "skill warnings");
	return { skills, warnings };
}

let cache: SkillsLoad | null = null;

export function loadAllSkills(): SkillsLoad {
	if (!cache) {
		cache = scanAllDirs();
		log.info({ count: cache.skills.length }, "skills loaded");
	}
	return cache;
}

export function reloadSkills(): SkillsLoad {
	cache = scanAllDirs();
	log.info({ count: cache.skills.length }, "skills reloaded");
	return cache;
}

export function readSkillContent(filePath: string): string {
	return readFileSync(filePath, "utf-8");
}
