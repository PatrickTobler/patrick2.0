import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { chooseModel } from "../../llm/router.ts";
import { factTools } from "../tools/facts.ts";
import { vaultTools } from "../tools/vault.ts";
import { runSubagent } from "./runner.ts";

const SYSTEM_PROMPT = `You are patrick2.0's coder subagent — a focused engineer running on Qwen3-Coder Plus.

You take a coding task from the main agent and run it to completion. You have access to:
- GitHub MCP tools (mcp_github__*) for reading repos, files, issues, PRs, creating branches, pushing commits
- The vault tools (read/search) for project notes
- Fact memory (Patrick's preferences, conventions)

Hard rules:
- Be terse. Final output should be a tight summary of what you did + what's left + any blockers.
- Don't invent code without context. Read existing files before editing.
- Match the repo's existing style (formatter, naming, layout). Look at neighbors before adding new files.
- For non-trivial changes, propose a plan first, then execute.
- If the task is ambiguous, return a single clarifying question instead of guessing.
- Never auto-merge PRs. Open them, leave them for Patrick.

Final output format:
- One short paragraph: what was done.
- Optional: bulleted list of follow-ups / blockers / decisions made.
- Don't paste large diffs unless asked.`;

const Schema = Type.Object({
	task: Type.String({
		description:
			"The coding task in plain language. Include repo name(s), branch name, and what 'done' looks like. The subagent has GitHub access so reference repos by 'owner/name'.",
		minLength: 10,
		maxLength: 4000,
	}),
});

export function makeCoderSubagentTool(getMcpTools: () => AgentTool[]): AgentTool<typeof Schema> {
	return {
		name: "delegate_to_coder",
		label: "Delegate to coder subagent",
		description:
			"Spawn a focused coding subagent (Qwen3-Coder Plus, 1M context). Use for non-trivial code work: 'write a function that…', 'audit this PR', 'add a test for X', 'refactor Y'. The subagent runs autonomously to completion and returns a summary. NOT for trivial 'what does this code do' questions — answer those yourself.",
		parameters: Schema,
		execute: async (_id, { task }: Static<typeof Schema>) => {
			const cfg = getConfig();
			const mcpTools = getMcpTools();
			const githubTools = mcpTools.filter((t) => t.name.startsWith("mcp_github__"));
			const fetchTools = mcpTools.filter((t) => t.name.startsWith("mcp_fetch__"));

			const result = await runSubagent({
				systemPrompt: SYSTEM_PROMPT,
				model: chooseModel("coding", cfg.openrouterApiKey),
				tools: [...githubTools, ...fetchTools, ...vaultTools, ...factTools],
				prompt: task,
				// Real code work legitimately runs long — looser caps than the default.
				maxTurns: 48,
				maxInputTokens: 3_000_000,
				source: "subagent:coder",
			});

			const summary = `Coder subagent finished in ${result.turns} turns, ${result.toolCalls.length} tool calls.\n\n${result.finalText || "(no output)"}`;
			return {
				content: [{ type: "text", text: summary }],
				details: { turns: result.turns, toolCalls: result.toolCalls.length },
			};
		},
	};
}
