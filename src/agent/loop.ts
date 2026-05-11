import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { insertPendingAction, resolveAction } from "../db/repos/actions.ts";
import { type MessageRow, type Role, insertMessage, loadRecent } from "../db/repos/messages.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";
import { ingestFactsFromMessage } from "./facts.ts";
import { buildRecallContext, buildStableSystemPrompt, withRecall } from "./memory-context.ts";
import { makeCoderSubagentTool } from "./subagents/coder.ts";
import {
	duneSubagentSpec,
	githubSubagentSpec,
	linearSubagentSpec,
	makeMcpDomainSubagent,
	webSubagentSpec,
} from "./subagents/mcp-domain.ts";
import { makeMoltbookSubagentTool } from "./subagents/moltbook.ts";
import { makeRedditSubagentTool } from "./subagents/reddit.ts";
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
import { whoopTools } from "./tools/whoop.ts";

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

// Tool results routinely include 10-30KB JSON blobs (masumi thread shows, github feeds, etc.).
// We persist the full text (for audits + action history), but when REHYDRATING into the next
// turn's conversation context we truncate — the model doesn't need to re-read 30KB of raw JSON
// it already acted on. Keeps the input window tight.
const TOOL_RESULT_HISTORY_MAX_CHARS = 800;

function truncateContent(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…(truncated, was ${text.length} chars)`;
}

function truncateToolMessage(msg: Message): Message {
	if (msg.role !== "toolResult") return msg;
	if (!Array.isArray(msg.content)) return msg;
	// biome-ignore lint/suspicious/noExplicitAny: pi's content union requires a cast here
	const truncated: any[] = msg.content.map((block) => {
		const b = block as unknown as { type: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") {
			return { ...block, text: truncateContent(b.text, TOOL_RESULT_HISTORY_MAX_CHARS) };
		}
		return block;
	});
	return { ...msg, content: truncated };
}

function rowToAgentMessage(row: MessageRow): Message {
	// Prefer the full serialized AgentMessage if we have it (preserves tool calls + results)
	if (row.raw_message && typeof row.raw_message === "object") {
		return truncateToolMessage(row.raw_message as Message);
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

	const recent = await loadRecent(chatId, 50);
	const recentIds = recent.map((r) => r.id);

	// Cache-aware split: stable prompt as the system prefix (identity + profile + skills index),
	// per-turn recall (facts/thinking/history) prepended to the user message instead. This keeps
	// the system prompt bytewise identical across turns so Anthropic's prompt cache stays warm,
	// while still grounding the model with relevance-selected memory.
	const [stableSystemPrompt, recall] = await Promise.all([
		buildStableSystemPrompt(),
		buildRecallContext(text, { excludeMessageIds: recentIds }),
	]);
	const promptedText = withRecall(text, recall);

	// We persist the augmented version in raw_message so next-turn rehydration produces the
	// exact same bytes the model already saw — preserving cache validity on the conversation
	// history too. The `content` column stays as the raw user text for clean search/audits.
	const userMsg: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: promptedText }],
		timestamp: Date.now(),
	};
	await insertMessage({ chatId, role: "user", content: text, rawMessage: userMsg });
	const history: AgentMessage[] = recent.map(rowToAgentMessage);

	// Track in-flight action rows so afterToolCall can resolve them
	const pendingActionByToolCallId = new Map<string, number>();

	const agent = new Agent({
		initialState: {
			systemPrompt: stableSystemPrompt,
			model: chooseModel("fast", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: [
				...factTools,
				...thinkingTools,
				...timeTools,
				...vaultTools,
				...calendarTools,
				...gmailTools,
				...whoopTools,
				...scheduleTools,
				...shellTools,
				...skillTools,
				...actionTools,
				...mcpMetaTools,
				// All MCP access goes through domain-scoped subagents to keep the main agent's
				// tool schema list tight. Each subagent owns one MCP server's tool surface.
				makeCoderSubagentTool(() => mcpTools),
				makeResearcherSubagentTool(() => mcpTools),
				makeMcpDomainSubagent(githubSubagentSpec, () => mcpTools),
				makeMcpDomainSubagent(linearSubagentSpec, () => mcpTools),
				makeMcpDomainSubagent(duneSubagentSpec, () => mcpTools),
				makeMcpDomainSubagent(webSubagentSpec, () => mcpTools),
				makeMoltbookSubagentTool(),
				makeRedditSubagentTool(),
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

	// Pass the recall-augmented text to the agent so the model sees the same content
	// we stored in raw_message — keeps wire/disk in sync for next-turn cache hits.
	await agent.prompt(promptedText);
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
