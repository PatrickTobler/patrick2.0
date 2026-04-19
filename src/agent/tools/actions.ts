import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type ActionRow,
	type Outcome,
	listActionsByOutcome,
	listActionsByTool,
	listRecentActions,
} from "../../db/repos/actions.ts";

const QuerySchema = Type.Object({
	tool: Type.Optional(
		Type.String({
			description: "Filter by tool name (e.g. 'remember_fact', 'mcp_github__list_issues').",
			maxLength: 80,
		}),
	),
	outcome: Type.Optional(
		Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("accepted"),
				Type.Literal("rejected"),
				Type.Literal("edited"),
				Type.Literal("errored"),
			],
			{ description: "Filter by outcome." },
		),
	),
	limit: Type.Optional(Type.Number({ description: "Max results.", minimum: 1, maximum: 200, default: 30 })),
});

export const queryActionsTool: AgentTool<typeof QuerySchema> = {
	name: "query_actions",
	label: "Query past actions",
	description:
		"Look up past tool-call history. Use when Patrick asks 'what did you do?', 'what failed today?', 'how many times have you called X', or wants to audit the agent's behavior. Returns timestamp, tool name, outcome, and a snippet of input.",
	parameters: QuerySchema,
	execute: async (_id, { tool, outcome, limit }: Static<typeof QuerySchema>) => {
		const max = limit ?? 30;
		let rows: ActionRow[];
		if (tool) rows = await listActionsByTool(tool, max);
		else if (outcome) rows = await listActionsByOutcome(outcome as Outcome, max);
		else rows = await listRecentActions(max);

		if (rows.length === 0) {
			return { content: [{ type: "text", text: "No matching actions." }], details: { results: [] } };
		}

		const lines = rows.map((r) => {
			const ts = r.created_at.toISOString().slice(0, 19).replace("T", " ");
			const inputStr = JSON.stringify(r.input).slice(0, 80);
			const errorStr = r.error ? ` err="${r.error.slice(0, 60)}"` : "";
			return `${ts} | ${r.outcome ?? "?"} | ${r.tool} ${inputStr}${errorStr}`;
		});
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { count: rows.length },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const actionTools: AgentTool<any>[] = [queryActionsTool];
