import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { chooseModel } from "../../llm/router.ts";
import { factTools } from "../tools/facts.ts";
import { recallThinkingTool } from "../tools/thinking.ts";
import { vaultTools } from "../tools/vault.ts";
import { runSubagent } from "./runner.ts";

const SYSTEM_PROMPT = `You are patrick2.0's researcher subagent — running on Kimi K2 Thinking, a reasoning-strong model with 262k context.

You take an investigative question from the main agent and produce a grounded answer. You have:
- Fetch tool to pull any URL
- Vault tools (search/read Patrick's Obsidian notes)
- Fact memory and thinking-recall (Patrick's prior reasoning on related topics)

Hard rules:
- Always search Patrick's vault and prior thinking FIRST. He's likely written about adjacent topics. Cite the note/date when you reuse his prior position.
- Then fetch external sources if needed. Quote sparingly, paraphrase tightly.
- Don't speculate. If sources disagree, say so and present each side.
- If the question is opinion-based, present 2-3 angles and let Patrick pick.
- Output: tight summary, then sources/links/notes used. Patrick wants signal, not a wall of text.`;

const Schema = Type.Object({
	question: Type.String({
		description:
			"The research question in natural language. Be specific about what kind of answer you need (a recommendation, a fact, a comparison, etc.).",
		minLength: 5,
		maxLength: 2000,
	}),
});

export function makeResearcherSubagentTool(getMcpTools: () => AgentTool[]): AgentTool<typeof Schema> {
	return {
		name: "delegate_to_researcher",
		label: "Delegate to researcher subagent",
		description:
			"Spawn a focused researcher subagent (Kimi K2-Thinking) for investigative questions that need synthesis from Patrick's notes + the web. Use for: 'compare X vs Y', 'what's the best practice for Z', 'find evidence for/against W', 'what have I written about V'. NOT for simple factual lookups (do those yourself).",
		parameters: Schema,
		execute: async (_id, { question }: Static<typeof Schema>) => {
			const cfg = getConfig();
			const mcpTools = getMcpTools();
			const fetchTools = mcpTools.filter((t) => t.name.startsWith("mcp_fetch__"));

			const result = await runSubagent({
				systemPrompt: SYSTEM_PROMPT,
				model: chooseModel("reasoning", cfg.openrouterApiKey),
				tools: [...fetchTools, ...vaultTools, ...factTools, recallThinkingTool],
				prompt: question,
			});

			const summary = `Researcher subagent finished in ${result.turns} turns, ${result.toolCalls.length} tool calls.\n\n${result.finalText || "(no output)"}`;
			return {
				content: [{ type: "text", text: summary }],
				details: { turns: result.turns, toolCalls: result.toolCalls.length },
			};
		},
	};
}
