import { handleUserMessage, setMcpTools } from "./agent/loop.ts";
import { setMcpToolsForScheduled } from "./agent/scheduled-runner.ts";
import { getConfig } from "./config.ts";
import { closePool } from "./db/pool.ts";
import { log } from "./log.ts";
import { startFactDecayJob, stopFactDecayJob } from "./maintenance/decay.ts";
import { ensureSeededSchedules } from "./maintenance/seed-schedules.ts";
import { startMasumiTokenRefresher, stopMasumiTokenRefresher } from "./masumi/auth-refresher.ts";
import { startMcpBridge, stopMcpBridge } from "./mcp/bridge.ts";
import { reloadAllSchedules, stopAllSchedules } from "./scheduler/service.ts";
import { createBot } from "./telegram/bot.ts";
import { startQueuedNotificationDelivery, stopQueuedNotificationDelivery } from "./telegram/queue-delivery.ts";

async function main(): Promise<void> {
	const cfg = getConfig();
	log.info({ env: cfg.nodeEnv }, "patrick2.0 booting");

	// Boot MCP bridge in background — don't block bot startup if servers are slow.
	void (async () => {
		try {
			const tools = await startMcpBridge();
			setMcpTools(tools);
			setMcpToolsForScheduled(tools);
		} catch (err) {
			log.error({ err }, "MCP bridge boot failed");
		}
	})();

	// Boot scheduler — ensure built-in schedules exist, then load all enabled schedules from DB
	try {
		await ensureSeededSchedules();
		const count = await reloadAllSchedules();
		log.info({ count }, "scheduler ready");
	} catch (err) {
		log.error({ err }, "scheduler boot failed");
	}

	// Boot masumi token refresher — the CLI's auto-refresh endpoint is broken; we refresh
	// the OAuth token on an interval (45 min) and write it back to the CLI's secrets store.
	startMasumiTokenRefresher();

	// Daily fact decay — keeps the recall pool weighted toward fresh + reinforced.
	startFactDecayJob();

	// Deliver notifications that were queued during quiet hours (07:00 batch).
	startQueuedNotificationDelivery();

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
		stopAllSchedules();
		stopMasumiTokenRefresher();
		stopQueuedNotificationDelivery();
		stopFactDecayJob();
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
