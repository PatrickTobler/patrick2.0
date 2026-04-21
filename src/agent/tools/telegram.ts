import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { insertMessage } from "../../db/repos/messages.ts";
import { log } from "../../log.ts";
import { sendTelegramToOwner } from "../../telegram/sender.ts";

const SendSchema = Type.Object({
	text: Type.String({
		description:
			"The Telegram message to send to Patrick. Plain text. Be tight — Patrick prefers signal over volume. If there's nothing worth interrupting him for, do NOT call this tool.",
		minLength: 1,
		maxLength: 4000,
	}),
});

export const sendTelegramMessageTool: AgentTool<typeof SendSchema> = {
	name: "send_telegram_message",
	label: "Send Telegram message",
	description:
		"Send a NEW Telegram message to Patrick (initiates a fresh message in chat). Use ONLY when running autonomously (e.g. inside a scheduled prompt) AND there's something Patrick genuinely needs to know. Silence is a valid outcome — don't ping for the sake of pinging. Do NOT use this when Patrick just messaged you (the bot replies in-thread automatically in that case).",
	parameters: SendSchema,
	execute: async (_id, { text }: Static<typeof SendSchema>) => {
		const sent = await sendTelegramToOwner(text);
		// Persist the bot-initiated message to the chat history so future user messages see it as context.
		try {
			const cfg = getConfig();
			const rawMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-completions",
				provider: "openai",
				model: "scheduled-push",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			await insertMessage({
				chatId: cfg.telegramOwnerChatId,
				role: "assistant",
				content: text,
				rawMessage,
			});
		} catch (err) {
			log.warn({ err }, "failed to persist scheduled telegram message to history");
		}
		return {
			content: [{ type: "text", text: `Sent (msg id ${sent.messageId}).` }],
			details: { messageId: sent.messageId },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const telegramTools: AgentTool<any>[] = [sendTelegramMessageTool];
