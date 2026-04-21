import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { insertPendingAction, resolveAction } from "../db/repos/actions.ts";
import { type MessageRow, type Role, insertMessage, loadRecent } from "../db/repos/messages.ts";
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
import { scheduleTools } from "./tools/schedules.ts";
import { shellTools } from "./tools/shell.ts";
import { skillTools } from "./tools/skills.ts";
import { thinkingTools } from "./tools/thinking.ts";
import { timeTools } from "./tools/time.ts";
// Native todos disabled — Patrick uses Linear instead. Keep the table for historical data;
// re-add `todoTools` here if we ever want them back.
import { vaultTools } from "./tools/vault.ts";

// biome-ignore lint/suspicious/noExplicitAny: tool schema generic erased at runtime
let mcpTools: AgentTool<any>[] = [];

// biome-ignore lint/suspicious/noExplicitAny: see above
export function setMcpTools(tools: AgentTool<any>[]): void {
	mcpTools = tools;
}

export interface ReplyChannel {
	send: (text: string) => Promise<{ messageId: number }>;
	edit: (messageId: number, text: string) => Promise<void>;
}

const EDIT_DEBOUNCE_MS = 600;

function rowToAgentMessage(row: MessageRow): Message {
	// Prefer the full serialized AgentMessage if we have it (preserves tool calls + results)
	if (row.raw_message && typeof row.raw_message === "object") {
		return row.raw_message as Message;
	}
	// Legacy rows: synthesize a minimal text-only message
	if (row.role === "user") {
		return { role: "user", content: [{ type: "text", text: row.content }], timestamp: row.created_at.getTime() };
	}
	if (row.role === "assistant") {
		return {
			role: "assistant",
			content: [{ type: "text", text: row.content }],
			api: "openai-completions",
			provider: "openai",
			model: "history",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: row.created_at.getTime(),
		};
	}
	return { role: "user", content: [{ type: "text", text: row.content }], timestamp: row.created_at.getTime() };
}

function summarizeForRow(m: AgentMessage): string {
	if (!Array.isArray(m.content)) return "";
	const parts: string[] = [];
	for (const raw of m.content) {
		const block = raw as unknown as { type: string; text?: string; name?: string };
		if (block.type === "text") parts.push(String(block.text ?? ""));
		else if (block.type === "toolCall") parts.push(`[tool: ${String(block.name ?? "?")}]`);
	}
	return parts.join("\n").trim();
}

function rowRoleFor(m: AgentMessage): Role {
	if (m.role === "toolResult") return "tool";
	if (m.role === "assistant") return "assistant";
	return "user";
}

export async function handleUserMessage(args: {
	chatId: number;
	text: string;
	reply: ReplyChannel;
}): Promise<void> {
	const cfg = getConfig();
	const { chatId, text, reply } = args;

	const userMsg: AgentMessage = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	await insertMessage({ chatId, role: "user", content: text, rawMessage: userMsg });
	const [recent, augmentedSystemPrompt] = await Promise.all([
		loadRecent(chatId, 50),
		buildSystemPromptWithMemory(text),
	]);
	const history: AgentMessage[] = recent.map(rowToAgentMessage);

	// Track in-flight action rows so afterToolCall can resolve them
	const pendingActionByToolCallId = new Map<string, number>();

	const agent = new Agent({
		initialState: {
			systemPrompt: augmentedSystemPrompt,
			model: chooseModel("fast", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: [
				...factTools,
				...thinkingTools,
				...timeTools,
				...vaultTools,
				...calendarTools,
				...gmailTools,
				...scheduleTools,
				...shellTools,
				...skillTools,
				...actionTools,
				...mcpMetaTools,
				makeCoderSubagentTool(() => mcpTools),
				makeResearcherSubagentTool(() => mcpTools),
				...mcpTools,
			],
			messages: history,
		},
		convertToLlm: (messages) => messages as Message[],
		getApiKey: () => cfg.openrouterApiKey,
		beforeToolCall: async ({ toolCall, args }) => {
			try {
				const row = await insertPendingAction({ tool: toolCall.name, input: args });
				pendingActionByToolCallId.set(toolCall.id, row.id);
			} catch (err) {
				log.warn({ err, tool: toolCall.name }, "action history insert failed");
			}
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
				log.warn({ err, actionId }, "action history resolve failed");
			}
			return undefined;
		},
	});

	void ingestFactsFromMessage(text);

	let placeholderId: number | null = null;
	let buffer = "";
	let lastEditAt = 0;
	let pendingEdit: NodeJS.Timeout | null = null;

	const flush = async (force = false): Promise<void> => {
		if (!buffer || placeholderId === null) return;
		const now = Date.now();
		if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) return;
		lastEditAt = now;
		try {
			await reply.edit(placeholderId, buffer);
		} catch (err) {
			log.warn({ err }, "telegram edit failed");
		}
	};

	agent.subscribe(async (event: AgentEvent) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			buffer += event.assistantMessageEvent.delta;
			if (placeholderId === null) {
				const sent = await reply.send(buffer);
				placeholderId = sent.messageId;
				lastEditAt = Date.now();
			} else {
				if (pendingEdit) clearTimeout(pendingEdit);
				pendingEdit = setTimeout(() => {
					void flush();
				}, EDIT_DEBOUNCE_MS);
			}
		}
	});

	await agent.prompt(text);
	await agent.waitForIdle();
	if (pendingEdit) clearTimeout(pendingEdit);
	await flush(true);

	// Persist every new message produced this turn (assistant text, tool calls, tool results) — skip
	// the user message which we already inserted above.
	const fresh = agent.state.messages.slice(history.length);
	for (const m of fresh) {
		if (m.role === "user") continue; // already persisted
		await insertMessage({
			chatId,
			role: rowRoleFor(m),
			content: summarizeForRow(m),
			rawMessage: m,
			...(m.role === "toolResult" && "toolCallId" in m && typeof m.toolCallId === "string"
				? { toolCallId: m.toolCallId }
				: {}),
		});
	}

	const final = collectAssistantText(agent.state.messages, history.length);
	if (!final && placeholderId === null) {
		await reply.send("(no response)");
	}
}

function collectAssistantText(messages: AgentMessage[], skip: number): string {
	const fresh = messages.slice(skip);
	const parts: string[] = [];
	for (const m of fresh) {
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "text") parts.push(block.text);
			}
		}
	}
	return parts.join("\n").trim();
}

export const __test = { rowToAgentMessage, collectAssistantText };

export type { Role };
