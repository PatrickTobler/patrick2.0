import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { log } from "../../log.ts";

export interface SubagentRunOptions {
	systemPrompt: string;
	model: Model<"openai-completions">;
	// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic erased at runtime
	tools: AgentTool<any>[];
	prompt: string;
	maxTurnsHint?: number;
}

export interface SubagentResult {
	finalText: string;
	turns: number;
	toolCalls: { name: string; isError: boolean }[];
}

/** Run a focused sub-Agent to completion. Captures the assistant text and tool history. */
export async function runSubagent(opts: SubagentRunOptions): Promise<SubagentResult> {
	const cfg = getConfig();
	const toolCalls: { name: string; isError: boolean }[] = [];
	let turns = 0;

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
		if (event.type === "turn_start") turns++;
	});

	try {
		await agent.prompt(opts.prompt);
		await agent.waitForIdle();
	} catch (err) {
		log.error({ err }, "subagent run failed");
		throw err;
	}

	return {
		finalText: collectAssistantText(agent.state.messages),
		turns,
		toolCalls,
	};
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
