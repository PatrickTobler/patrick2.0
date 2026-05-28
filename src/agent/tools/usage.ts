import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { type UsageSummary, summarizeUsageSince } from "../../db/repos/usage.ts";

const Schema = Type.Object({
	hours: Type.Optional(
		Type.Number({
			description: "Look-back window in hours. Default 24 (the last day). Clamped to 1–168.",
			minimum: 1,
			maximum: 168,
		}),
	),
});

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtUsd(n: number): string {
	if (n > 0 && n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

export function formatUsageSummary(s: UsageSummary, hours: number): string {
	const window = hours === 24 ? "last 24h" : `last ${hours}h`;
	if (s.totalTokens === 0) {
		return `LLM token spend (${window}): none recorded — no model calls in this window.`;
	}
	const lines: string[] = [
		`LLM token spend (${window}): ${fmtTokens(s.totalTokens)} tokens (${fmtTokens(s.inputTokens)} in / ${fmtTokens(s.outputTokens)} out) · ${fmtUsd(s.totalCostUsd)} est.`,
	];
	if (s.byModel.length > 0) {
		lines.push("By model:");
		for (const m of s.byModel) {
			lines.push(`  • ${m.key}: ${fmtTokens(m.totalTokens)} · ${fmtUsd(m.costUsd)}`);
		}
	}
	if (s.bySource.length > 0) {
		lines.push("By source:");
		for (const src of s.bySource) {
			lines.push(`  • ${src.key}: ${fmtTokens(src.totalTokens)} · ${fmtUsd(src.costUsd)}`);
		}
	}
	return lines.join("\n");
}

export const getTokenUsageTool: AgentTool<typeof Schema> = {
	name: "get_token_usage",
	label: "Token usage",
	description:
		"Get Patrick's LLM token spend (tokens + estimated USD cost) over a recent window, with a per-model and per-source breakdown. Covers the orchestrator, all subagents, scheduled runs, and background extraction. Default window is the last 24 hours.",
	parameters: Schema,
	execute: async (_id, { hours }: Static<typeof Schema>) => {
		const window = Math.min(Math.max(hours ?? 24, 1), 168);
		const since = new Date(Date.now() - window * 60 * 60 * 1000);
		const summary = await summarizeUsageSince(since);
		const text = formatUsageSummary(summary, window);
		return {
			content: [{ type: "text", text }],
			details: { hours: window, ...summary },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const usageTools: AgentTool<any>[] = [getTokenUsageTool];
