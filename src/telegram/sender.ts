import { Bot } from "grammy";
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
