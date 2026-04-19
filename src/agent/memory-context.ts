import { recallFacts } from "../db/repos/facts.ts";
import { searchHistory } from "../db/repos/messages.ts";
import { recallThinking } from "../db/repos/thinking.ts";
import { loadAllSkills } from "../skills/loader.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

const MAX_FACTS = 8;
const MAX_THINKING = 4;
const MAX_HISTORY = 3;
const FACT_SIM_THRESHOLD = 0.3;
const THINKING_SIM_THRESHOLD = 0.35;
const HISTORY_SIM_THRESHOLD = 0.4;

export async function buildSystemPromptWithMemory(userText: string): Promise<string> {
	const [facts, thinking, history] = await Promise.all([
		recallFacts(userText, MAX_FACTS),
		recallThinking(userText, MAX_THINKING),
		searchHistory(userText, MAX_HISTORY),
	]);

	const sections: string[] = [SYSTEM_PROMPT];

	const { skills } = loadAllSkills();
	const exposedSkills = skills.filter((s) => !s.disableModelInvocation);
	if (exposedSkills.length > 0) {
		const lines = exposedSkills.map((s) => `- **${s.name}**: ${s.description}`);
		sections.push(
			`## Skills available to you\nThese are domain-specific instruction sets. Each one's name + description is shown below. To use one, call read_skill with its name to load the full SKILL.md, then follow the instructions.\n\n${lines.join("\n")}`,
		);
	}

	const relevantFacts = facts.filter((f) => f.similarity >= FACT_SIM_THRESHOLD);
	if (relevantFacts.length > 0) {
		const lines = relevantFacts.map((f) => `- ${f.text}`);
		sections.push(`## What you know about Patrick (relevant to this turn)\n${lines.join("\n")}`);
	}

	const relevantThinking = thinking.filter((t) => t.similarity >= THINKING_SIM_THRESHOLD);
	if (relevantThinking.length > 0) {
		const lines = relevantThinking.map((t) => {
			const date = t.created_at.toISOString().slice(0, 10);
			const topics = t.topics?.length ? ` [${t.topics.join(", ")}]` : "";
			return `### (${date})${topics}\n${t.text}`;
		});
		sections.push(
			`## Patrick's recent thinking on this topic\nThese are evolving positions, not stable facts. Current view may differ — but use them as ground truth for how he reasons.\n\n${lines.join("\n\n")}`,
		);
	}

	const relevantHistory = history.filter((m) => m.similarity >= HISTORY_SIM_THRESHOLD && m.role === "user");
	if (relevantHistory.length > 0) {
		const lines = relevantHistory.map((m) => {
			const date = m.created_at.toISOString().slice(0, 10);
			const snippet = m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content;
			return `- (${date}) ${snippet}`;
		});
		sections.push(`## Past things Patrick said that may be relevant\n${lines.join("\n")}`);
	}

	return sections.join("\n\n");
}
