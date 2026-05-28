import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { type ModelClass, chooseModel } from "../../llm/router.ts";
import { runSubagent } from "./runner.ts";

interface McpDomainSpec {
	/** Tool name surfaced to the main agent, e.g. "delegate_to_github". */
	toolName: string;
	/** Short label. */
	label: string;
	/** Description shown to the main agent — tells it WHEN to delegate here. */
	description: string;
	/** Prefix of MCP tool names to include, e.g. "mcp_github__". */
	mcpPrefix: string;
	/** Optional extra tools always available inside this subagent (e.g. fetch on top of github). */
	extraMcpPrefixes?: string[];
	/** Model class to use. Defaults to "economy". */
	modelClass?: ModelClass;
	/** System prompt for the subagent — tells it its role + conventions. */
	systemPrompt: string;
}

const Schema = Type.Object({
	task: Type.String({
		description:
			"The task in plain language. Be specific: what to look up, what action, what to return. The subagent is stateless — restate any context it needs.",
		minLength: 5,
		maxLength: 4000,
	}),
});

export function makeMcpDomainSubagent(spec: McpDomainSpec, getMcpTools: () => AgentTool[]): AgentTool<typeof Schema> {
	return {
		name: spec.toolName,
		label: spec.label,
		description: spec.description,
		parameters: Schema,
		execute: async (_id, { task }: Static<typeof Schema>) => {
			const cfg = getConfig();
			const all = getMcpTools();
			const allowedPrefixes = [spec.mcpPrefix, ...(spec.extraMcpPrefixes ?? [])];
			const scoped = all.filter((t) => allowedPrefixes.some((p) => t.name.startsWith(p)));

			const result = await runSubagent({
				systemPrompt: spec.systemPrompt,
				model: chooseModel(spec.modelClass ?? "economy", cfg.openrouterApiKey),
				tools: scoped,
				prompt: task,
				source: `subagent:${spec.toolName}`,
			});

			const summary = `${spec.label} subagent done in ${result.turns} turns, ${result.toolCalls.length} tool calls.\n\n${result.finalText || "(no output)"}`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					turns: result.turns,
					toolCalls: result.toolCalls.length,
					errors: result.toolCalls.filter((c) => c.isError).length,
				},
			};
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Concrete domain subagents

export const githubSubagentSpec: McpDomainSpec = {
	toolName: "delegate_to_github",
	label: "GitHub subagent",
	description:
		"Delegate ANY GitHub query or write to a focused subagent (scoped to github MCP tools only). Use for: list/search/read issues, PRs, commits, files, releases; create/update issues, PRs, comments; repo inspection. Returns a concise summary. Do NOT try to answer github questions yourself — always delegate.",
	mcpPrefix: "mcp_github__",
	systemPrompt: `You are Patrick's focused GitHub subagent. You get GitHub tasks from the main agent and return concise summaries.

Principles:
- Answer with signal, not raw JSON dumps. Summarize counts, names, links.
- For searches: top 5-10 results only, with direct links.
- For writes (create issue, comment, PR): restate what you did + link.
- Never open PRs or merge anything the task didn't explicitly authorize.
- If Patrick's context matters (his username, his team), assume PatrickTobler and the masumi-network org unless told otherwise.
- Plain text output. No markdown formatting in the final summary.`,
};

export const linearSubagentSpec: McpDomainSpec = {
	toolName: "delegate_to_linear",
	label: "Linear subagent",
	description:
		"Delegate Linear tasks to a focused subagent. Use for: list/search/create/update issues, projects, cycles; check assignments and state transitions; read comments; create todos for Patrick (since native todos are disabled, Linear IS Patrick's task list). Returns a concise summary.",
	mcpPrefix: "mcp_linear__",
	systemPrompt: `You are Patrick's focused Linear subagent. Linear is Patrick's task system — when he says "add a reminder" or "create a todo", create a Linear issue.

Principles:
- Default assignee for Patrick's own tasks: his Linear user (auto-detect via linear_getUser or similar).
- Default project/team: ask linear first if unsure.
- For "what's going on" queries: show recent activity across the team, not just Patrick's backlog.
- For creates: confirm the issue identifier (PAT-123) + link.
- Plain text output. No markdown.`,
};

export const duneSubagentSpec: McpDomainSpec = {
	toolName: "delegate_to_dune",
	label: "Dune subagent",
	description:
		"Delegate Dune Analytics queries to a focused subagent. Use for: search for datasets, run/execute Dune queries, get execution results, generate or fetch visualizations (PNG URLs), manage dashboards. Good for on-chain data, Masumi traction, token metrics. Returns a concise summary + any relevant URLs/numbers.",
	mcpPrefix: "mcp_dune__",
	systemPrompt: `You are Patrick's focused Dune Analytics subagent. You run queries, fetch data, and return numbers + visualization URLs.

Principles:
- For traction-style reports: this week vs last week, % change, headline number.
- For ad-hoc queries: execute, wait for results, return top 10 rows max in table form.
- For visualizations: return the PNG URL so the main agent can pass it to send_telegram_photo.
- If a query fails or has no data, say so in one line rather than padding.
- Plain text output.`,
};

export const webSubagentSpec: McpDomainSpec = {
	toolName: "delegate_to_web",
	label: "Web fetch subagent",
	description:
		"Delegate web fetch / URL reading to a focused subagent. Use for: reading any URL, scraping HTML pages, fetching API endpoints, summarizing articles. Returns a concise summary with key info and citations to the source URL.",
	mcpPrefix: "mcp_fetch__",
	systemPrompt: `You are Patrick's focused web fetch subagent. You pull URLs and return tight summaries.

Principles:
- Never paste raw HTML or giant JSON. Summarize into the specific information Patrick/the main agent needs.
- Cite the source URL clearly.
- If a URL fails or is paywalled, say so in one line.
- Plain text output. No markdown.`,
};
