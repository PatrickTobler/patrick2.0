import { Bot, type Context } from "grammy";
import { getConfig } from "../config.ts";
import { log } from "../log.ts";

export type Handler = (ctx: HandlerContext) => Promise<void>;

export interface HandlerContext {
	chatId: number;
	text: string;
	messageId: number;
	reply: (text: string) => Promise<{ messageId: number }>;
	editReply: (messageId: number, text: string) => Promise<void>;
}

export interface BotHandle {
	bot: Bot;
	start: () => Promise<void>;
	stop: () => Promise<void>;
}

export function createBot(handler: Handler): BotHandle {
	const cfg = getConfig();
	const bot = new Bot(cfg.telegramBotToken);

	bot.use(async (ctx, next) => {
		const chatId = ctx.chat?.id;
		if (chatId !== cfg.telegramOwnerChatId) {
			log.warn({ chatId }, "rejected non-allowlisted chat");
			return;
		}
		await next();
	});

	// Wipe any previously-registered slash commands so the / autocomplete is empty.
	void bot.api.setMyCommands([]);

	bot.on("message:text", async (ctx) => {
		await dispatch(ctx, handler);
	});

	bot.catch((err) => {
		log.error({ err }, "telegram error");
	});

	return {
		bot,
		start: async () => {
			log.info("telegram bot starting (long-poll)");
			await bot.start({ drop_pending_updates: true });
		},
		stop: async () => {
			await bot.stop();
		},
	};
}

async function dispatch(ctx: Context, handler: Handler): Promise<void> {
	const chatId = ctx.chat?.id;
	const messageId = ctx.message?.message_id;
	const text = ctx.message?.text;
	if (!chatId || !messageId || !text) return;

	const handlerCtx: HandlerContext = {
		chatId,
		text,
		messageId,
		reply: async (t) => {
			const sent = await ctx.reply(t);
			return { messageId: sent.message_id };
		},
		editReply: async (id, t) => {
			await ctx.api.editMessageText(chatId, id, t);
		},
	};

	try {
		await handler(handlerCtx);
	} catch (err) {
		log.error({ err, chatId }, "handler crashed");
		await ctx.reply("Something broke, I logged it").catch(() => {});
	}
}

export function isAllowedChat(chatId: number | undefined, ownerId: number): boolean {
	return chatId === ownerId;
}
