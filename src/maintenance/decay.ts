import cron, { type ScheduledTask } from "node-cron";
import { decayFacts } from "../db/repos/facts.ts";
import { log } from "../log.ts";

let task: ScheduledTask | null = null;

const CRON_DAILY_3AM_ZURICH = "0 3 * * *";

export function startFactDecayJob(): void {
	if (task) return;
	const run = async () => {
		try {
			const result = await decayFacts({ daysSinceUpdate: 7, multiplier: 0.95, minConfidence: 0.2 });
			log.info({ ...result, msg: "fact decay" });
		} catch (err) {
			log.error({ err }, "fact decay failed");
		}
	};
	task = cron.schedule(CRON_DAILY_3AM_ZURICH, () => void run(), { timezone: "Europe/Zurich" });
	log.info({ cron: CRON_DAILY_3AM_ZURICH, tz: "Europe/Zurich" }, "fact decay job registered");
}

export function stopFactDecayJob(): void {
	if (task) task.stop();
	task = null;
}
