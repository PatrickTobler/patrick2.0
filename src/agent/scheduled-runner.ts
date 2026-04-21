import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { insertPendingAction, resolveAction } from "../db/repos/actions.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";
import { ingestFactsFromMessage } from "./facts.ts";
import { buildSystemPromptWithMemory } from "./memory-context.ts";
import { makeCoderSubagentTool } from "./subagents/coder.ts";
import { makeResearcherSubagentTool } from "./subagents/researcher.ts";
import { actionTools } from "./tools/actions.ts";
import { calendarTools } from "./tools/calendar.ts";
import { factTools } from "./tools/facts.ts";
import { gmailTools } from "./tools/gmail.ts";
import { mcpMetaTools } from "./tools/mcp-meta.ts";
import { shellTools } from "./tools/shell.ts";
import { skillTools } from "./tools/skills.ts";
import { telegramTools } from "./tools/telegram.ts";
import { thinkingTools } from "./tools/thinking.ts";
import { timeTools } from "./tools/time.ts";
// Native todos disabled — Patrick uses Linear (via MCP) instead.
import { vaultTools } from "./tools/vault.ts";

const SCHEDULED_BANNER = `
You are running on a schedule — Patrick did NOT just message you. This is autonomous time.

Rules:
- The "user" message below is the scheduled prompt. Treat it as instructions, not a conversation.
- Use any tools you need (memory, calendar, gmail, vault, MCP, subagents, skills) to fulfill it.
- If — and only if — there's something genuinely worth interrupting Patrick for, call send_telegram_message. Silence is acceptable and often correct.
- Do NOT call send_telegram_message just to confirm you ran. Patrick can audit via query_actions.
- Be tight. Match Patrick's tone (terse, direct, plain).
`;

export interface ScheduledRunResult {
	finalText: string;
	telegramSent: boolean;
	toolCallCount: number;
}

// biome-ignore lint/suspicious/noExplicitAny: tool schema generic erased at runtime
let mcpToolsRef: AgentTool<any>[] = [];

// biome-ignore lint/suspicious/noExplicitAny: see above
export function setMcpToolsForScheduled(tools: AgentTool<any>[]): void {
	mcpToolsRef = tools;
}

export async function runScheduledPrompt(scheduleId: number, prompt: string): Promise<ScheduledRunResult> {
	const cfg = getConfig();
	const augmentedSystemPrompt = await buildSystemPromptWithMemory(prompt);
	const systemPrompt = `${augmentedSystemPrompt}\n\n${SCHEDULED_BANNER}`;

	const pendingActionByToolCallId = new Map<string, number>();
	let telegramSent = false;
	let toolCallCount = 0;

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: chooseModel("fast", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: [
				...factTools,
				...thinkingTools,
				...timeTools,
				...vaultTools,
				...calendarTools,
				...gmailTools,
				...telegramTools,
				...shellTools,
				...skillTools,
				...actionTools,
				...mcpMetaTools,
				makeCoderSubagentTool(() => mcpToolsRef),
				makeResearcherSubagentTool(() => mcpToolsRef),
				...mcpToolsRef,
			],
			messages: [],
		},
		convertToLlm: (messages) => messages as Message[],
		getApiKey: () => cfg.openrouterApiKey,
		beforeToolCall: async ({ toolCall, args }) => {
			toolCallCount++;
			try {
				const row = await insertPendingAction({
					tool: `cron:${scheduleId}:${toolCall.name}`,
					input: args,
				});
				pendingActionByToolCallId.set(toolCall.id, row.id);
			} catch (err) {
				log.warn({ err }, "scheduled action insert failed");
			}
			if (toolCall.name === "send_telegram_message") telegramSent = true;
			return undefined;
		},
		afterToolCall: async ({ toolCall, result, isError }) => {
			const actionId = pendingActionByToolCallId.get(toolCall.id);
			if (actionId == null) return undefined;
			pendingActionByToolCallId.delete(toolCall.id);
			try {
				const summary = result.content
					.filter((c) => c.type === "text")
					.map((c) => (c as { type: "text"; text: string }).text)
					.join("\n")
					.slice(0, 2000);
				await resolveAction(
					actionId,
					isError ? "errored" : "accepted",
					{ summary, details: result.details },
					isError ? summary.slice(0, 500) : undefined,
				);
			} catch (err) {
				log.warn({ err, actionId }, "scheduled action resolve failed");
			}
			return undefined;
		},
	});

	void ingestFactsFromMessage(prompt);

	await agent.prompt(prompt);
	await agent.waitForIdle();

	const finalText = collectAssistantText(agent.state.messages);
	return { finalText, telegramSent, toolCallCount };
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
