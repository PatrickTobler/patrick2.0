import cron, { type ScheduledTask } from "node-cron";
import { runScheduledPrompt } from "../agent/scheduled-runner.ts";
import { type ScheduleRow, listSchedules, markFired } from "../db/repos/schedules.ts";
import { log } from "../log.ts";

const tasks = new Map<number, ScheduledTask>();

async function fire(schedule: ScheduleRow): Promise<void> {
	const start = Date.now();
	log.info({ scheduleId: schedule.id, cron: schedule.cron }, "scheduled prompt firing");
	try {
		const result = await runScheduledPrompt(schedule.id, schedule.prompt);
		await markFired(schedule.id);
		log.info(
			{
				scheduleId: schedule.id,
				ms: Date.now() - start,
				telegramSent: result.telegramSent,
				toolCalls: result.toolCallCount,
			},
			"scheduled prompt finished",
		);
	} catch (err) {
		log.error({ err, scheduleId: schedule.id }, "scheduled prompt failed");
	}
}

function register(schedule: ScheduleRow): void {
	if (!schedule.enabled) return;
	if (!cron.validate(schedule.cron)) {
		log.warn({ scheduleId: schedule.id, cron: schedule.cron }, "invalid cron expression — skipped");
		return;
	}
	const task = cron.schedule(
		schedule.cron,
		() => {
			void fire(schedule);
		},
		{ timezone: schedule.timezone },
	);
	tasks.set(schedule.id, task);
	log.info({ scheduleId: schedule.id, cron: schedule.cron, tz: schedule.timezone }, "schedule registered");
}

export async function reloadAllSchedules(): Promise<number> {
	for (const [id, task] of tasks) {
		task.stop();
		tasks.delete(id);
	}
	const schedules = await listSchedules();
	for (const s of schedules) register(s);
	return tasks.size;
}

export async function reloadOneSchedule(id: number): Promise<void> {
	const existing = tasks.get(id);
	if (existing) {
		existing.stop();
		tasks.delete(id);
	}
	const schedules = await listSchedules();
	const s = schedules.find((x) => x.id === id);
	if (s) register(s);
}

export function listActiveSchedules(): number[] {
	return Array.from(tasks.keys());
}

export function stopAllSchedules(): void {
	for (const [, task] of tasks) task.stop();
	tasks.clear();
}
