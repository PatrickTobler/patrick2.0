import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { loadAllSkills, readSkillContent, reloadSkills } from "../../skills/loader.ts";

const ListSchema = Type.Object({});

export const listSkillsTool: AgentTool<typeof ListSchema> = {
	name: "list_skills",
	label: "List skills",
	description:
		"List every skill that's currently available, with name + short description. Skills are domain-specific instruction sets stored as markdown files. Always check this first when Patrick asks 'what can you do' or when a task seems specialized (deploys, design review, GA4 queries, etc.) — there may be a skill for it.",
	parameters: ListSchema,
	execute: async () => {
		const { skills } = loadAllSkills();
		if (skills.length === 0) {
			return { content: [{ type: "text", text: "No skills loaded." }], details: { skills: [] } };
		}
		const lines = skills.map((s) => `- **${s.name}** (${s.source}): ${s.description}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { skills: skills.map((s) => ({ name: s.name, source: s.source })) },
		};
	},
};

const ReadSchema = Type.Object({
	name: Type.String({ description: "Exact skill name as listed by list_skills.", minLength: 1, maxLength: 64 }),
});

export const readSkillTool: AgentTool<typeof ReadSchema> = {
	name: "read_skill",
	label: "Read a skill",
	description:
		"Load the full SKILL.md content for a named skill. Call this when a task matches a skill from list_skills — the file contains step-by-step instructions you should follow.",
	parameters: ReadSchema,
	execute: async (_id, { name }: Static<typeof ReadSchema>) => {
		const { skills } = loadAllSkills();
		const skill = skills.find((s) => s.name === name);
		if (!skill) {
			return {
				content: [{ type: "text", text: `No skill named "${name}". Use list_skills to see what's available.` }],
				details: { found: false },
			};
		}
		const content = readSkillContent(skill.filePath);
		return {
			content: [{ type: "text", text: `# Skill: ${skill.name}\nSource: ${skill.filePath}\n\n${content}` }],
			details: { name: skill.name, filePath: skill.filePath, bytes: content.length },
		};
	},
};

const ReloadSchema = Type.Object({});

export const reloadSkillsTool: AgentTool<typeof ReloadSchema> = {
	name: "reload_skills",
	label: "Reload skills",
	description:
		"Re-scan all skill directories from disk. Use when Patrick says he added or edited a skill and wants you to pick it up without restarting.",
	parameters: ReloadSchema,
	execute: async () => {
		const { skills, warnings } = reloadSkills();
		return {
			content: [{ type: "text", text: `Reloaded. ${skills.length} skills loaded, ${warnings.length} warnings.` }],
			details: { count: skills.length, warnings: warnings.length },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const skillTools: AgentTool<any>[] = [listSkillsTool, readSkillTool, reloadSkillsTool];
