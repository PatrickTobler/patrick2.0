import { Bot, InputFile } from "grammy";
import { getConfig } from "../config.ts";

let bot: Bot | null = null;

function getSenderBot(): Bot {
	if (bot) return bot;
	bot = new Bot(getConfig().telegramBotToken);
	return bot;
}

export async function sendTelegramToOwner(text: string): Promise<{ messageId: number }> {
	const cfg = getConfig();
	const sent = await getSenderBot().api.sendMessage(cfg.telegramOwnerChatId, text);
	return { messageId: sent.message_id };
}

export async function sendTelegramPhotoToOwner(
	input: { url: string; caption?: string } | { buffer: Buffer; filename: string; caption?: string },
): Promise<{ messageId: number }> {
	const cfg = getConfig();
	const api = getSenderBot().api;
	const extra = "caption" in input && input.caption ? { caption: input.caption } : {};
	const photo = "url" in input ? input.url : new InputFile(input.buffer, input.filename);
	const sent = await api.sendPhoto(cfg.telegramOwnerChatId, photo, extra);
	return { messageId: sent.message_id };
}
