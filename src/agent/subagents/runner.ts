import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { log } from "../../log.ts";
import { recordUsageFromMessages } from "../usage-tracking.ts";

export interface SubagentRunOptions {
	systemPrompt: string;
	model: Model<"openai-completions">;
	// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic erased at runtime
	tools: AgentTool<any>[];
	prompt: string;
	/** Hard turn limit. The run is steered to wrap up near the cap and aborted at it. */
	maxTurns?: number;
	/** Hard budget for summed input tokens across the run. Aborted when exceeded. */
	maxInputTokens?: number;
	/** Usage-tracking label, e.g. "subagent:reddit". Defaults to "subagent". */
	source?: string;
}

export interface SubagentResult {
	finalText: string;
	turns: number;
	toolCalls: { name: string; isError: boolean }[];
	/** Set when the run was cut off by the turn or token cap. */
	abortedBy?: "turns" | "tokens";
}

// Defaults sized for "focused single task" subagents. The Moltbook ghost cron burned
// ~3.4M tokens per run with no cap — these exist so a confused subagent costs cents,
// not dollars, before it gets cut off.
const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_INPUT_TOKENS = 1_000_000;

/** Run a focused sub-Agent to completion. Captures the assistant text and tool history. */
export async function runSubagent(opts: SubagentRunOptions): Promise<SubagentResult> {
	const cfg = getConfig();
	const toolCalls: { name: string; isError: boolean }[] = [];
	const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
	let turns = 0;
	let inputTokens = 0;
	let abortedBy: SubagentResult["abortedBy"];

	const agent = new Agent({
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: opts.model,
			thinkingLevel: "off",
			tools: opts.tools,
			messages: [],
		},
		convertToLlm: (messages) => messages as Message[],
		getApiKey: () => cfg.openrouterApiKey,
		afterToolCall: async ({ toolCall, isError }) => {
			toolCalls.push({ name: toolCall.name, isError });
			return undefined;
		},
	});

	agent.subscribe((event: AgentEvent) => {
		if (event.type !== "turn_start") return;
		turns++;
		inputTokens = sumInputTokens(agent.state.messages);
		if (turns > maxTurns || inputTokens > maxInputTokens) {
			abortedBy = turns > maxTurns ? "turns" : "tokens";
			log.warn({ source: opts.source, turns, inputTokens, maxTurns, maxInputTokens }, "subagent hit cap — aborting");
			agent.abort();
		} else if (turns === maxTurns - 2) {
			agent.steer({
				role: "user",
				content: [
					{
						type: "text",
						text: "[runtime] You are 2 turns from the hard turn limit. Stop exploring, finish the task with what you have, and return your summary now.",
					},
				],
				timestamp: Date.now(),
			} as AgentMessage);
		}
	});

	try {
		await agent.prompt(opts.prompt);
		await agent.waitForIdle();
	} catch (err) {
		if (!abortedBy) {
			log.error({ err }, "subagent run failed");
			throw err;
		}
		// Cap-triggered abort: salvage whatever the subagent produced so far.
		log.warn({ err, abortedBy }, "subagent aborted by cap — returning partial result");
	}

	void recordUsageFromMessages(opts.source ?? "subagent", agent.state.messages);

	const finalText = collectAssistantText(agent.state.messages);
	return {
		finalText: abortedBy
			? `${finalText}\n\n[runtime] Run cut off by ${abortedBy === "turns" ? `turn cap (${maxTurns})` : `token budget (${maxInputTokens})`} — result may be incomplete.`
			: finalText,
		turns,
		toolCalls,
		...(abortedBy ? { abortedBy } : {}),
	};
}

interface UsageMessage {
	role: string;
	usage?: { input?: number };
}

function sumInputTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) {
		const u = m as unknown as UsageMessage;
		if (u.role === "assistant" && u.usage?.input) total += u.usage.input;
	}
	return total;
}

function collectAssistantText(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}
