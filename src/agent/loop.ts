import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { type MessageRow, type Role, insertMessage, loadRecent } from "../db/repos/messages.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";
import { ingestFactsFromMessage } from "./facts.ts";
import { buildSystemPromptWithMemory } from "./memory-context.ts";
import { factTools } from "./tools/facts.ts";
import { mcpMetaTools } from "./tools/mcp-meta.ts";
import { skillTools } from "./tools/skills.ts";

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

export async function handleUserMessage(args: {
	chatId: number;
	text: string;
	reply: ReplyChannel;
}): Promise<void> {
	const cfg = getConfig();
	const { chatId, text, reply } = args;

	await insertMessage({ chatId, role: "user", content: text });
	const [recent, augmentedSystemPrompt] = await Promise.all([
		loadRecent(chatId, 50),
		buildSystemPromptWithMemory(text),
	]);
	const history: AgentMessage[] = recent.map(rowToAgentMessage);

	const agent = new Agent({
		initialState: {
			systemPrompt: augmentedSystemPrompt,
			model: chooseModel("fast", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: [...factTools, ...skillTools, ...mcpMetaTools, ...mcpTools],
			messages: history,
		},
		convertToLlm: (messages) => messages as Message[],
		getApiKey: () => cfg.openrouterApiKey,
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

	const final = collectAssistantText(agent.state.messages, history.length);
	if (final) {
		await insertMessage({ chatId, role: "assistant", content: final });
	} else if (placeholderId === null) {
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
