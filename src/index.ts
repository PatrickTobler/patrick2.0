import { handleUserMessage, setMcpTools } from "./agent/loop.ts";
import { getConfig } from "./config.ts";
import { closePool } from "./db/pool.ts";
import { log } from "./log.ts";
import { startMcpBridge, stopMcpBridge } from "./mcp/bridge.ts";
import { createBot } from "./telegram/bot.ts";

async function main(): Promise<void> {
	const cfg = getConfig();
	log.info({ env: cfg.nodeEnv }, "patrick2.0 booting");

	// Boot MCP bridge in background — don't block bot startup if servers are slow.
	void (async () => {
		try {
			const tools = await startMcpBridge();
			setMcpTools(tools);
		} catch (err) {
			log.error({ err }, "MCP bridge boot failed");
		}
	})();

	const handle = createBot(async (ctx) => {
		await handleUserMessage({
			chatId: ctx.chatId,
			text: ctx.text,
			reply: {
				send: ctx.reply,
				edit: ctx.editReply,
			},
		});
	});

	const shutdown = async (signal: string) => {
		log.info({ signal }, "shutting down");
		await handle.stop().catch(() => {});
		await stopMcpBridge().catch(() => {});
		await closePool().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await handle.start();
}

main().catch((err) => {
	log.error({ err }, "fatal");
	process.exit(1);
});
