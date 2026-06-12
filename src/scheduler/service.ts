import cron, { type ScheduledTask } from "node-cron";
import { lintScheduleToolRefs, runScheduledPrompt } from "../agent/scheduled-runner.ts";
import { type ScheduleRow, listSchedules, markFired, updateSchedule } from "../db/repos/schedules.ts";
import { log } from "../log.ts";

const tasks = new Map<number, ScheduledTask>();

async function fire(schedule: ScheduleRow): Promise<void> {
	const start = Date.now();
	log.info({ scheduleId: schedule.id, cron: schedule.cron }, "scheduled prompt firing");
	try {
		const result = await runScheduledPrompt(schedule.id, schedule.prompt, {
			tools: schedule.tools,
			modelClass: schedule.model_class,
		});
		await markFired(schedule.id);
		if (schedule.one_shot) {
			// One-shots retire themselves in code — prompts can't ("pause yourself" needs
			// a tool scheduled runs don't have; the rent reminder fired silently for weeks).
			await updateSchedule(schedule.id, { enabled: false });
			const key = Number(schedule.id);
			tasks.get(key)?.stop();
			tasks.delete(key);
			log.info({ scheduleId: schedule.id }, "one-shot schedule completed and disabled");
		}
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

function register(schedule: ScheduleRow): boolean {
	if (!schedule.enabled) return false;
	if (!cron.validate(schedule.cron)) {
		log.warn({ scheduleId: schedule.id, cron: schedule.cron }, "invalid cron expression — skipped");
		return false;
	}
	const task = cron.schedule(
		schedule.cron,
		() => {
			void fire(schedule);
		},
		{ timezone: schedule.timezone },
	);
	// Number() guards against ids arriving as strings (pg returns int8 as string unless
	// a type parser is set) — a string key here is how the Moltbook ghost cron survived
	// its own deletion for 10 days.
	tasks.set(Number(schedule.id), task);
	const unavailable = lintScheduleToolRefs(schedule.prompt, schedule.tools);
	if (unavailable.length > 0) {
		log.warn(
			{ scheduleId: schedule.id, unavailable },
			"schedule prompt references tools its runs do not have — instructions will be silently ignored",
		);
	}
	log.info({ scheduleId: schedule.id, cron: schedule.cron, tz: schedule.timezone }, "schedule registered");
	return true;
}

export interface ReloadResult {
	/** True if a live in-memory task existed and was stopped. */
	stoppedLiveTask: boolean;
	/** True if the schedule is now registered with a live task. */
	nowRegistered: boolean;
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

export async function reloadOneSchedule(id: number): Promise<ReloadResult> {
	const key = Number(id);
	const existing = tasks.get(key);
	if (existing) {
		existing.stop();
		tasks.delete(key);
	}
	const schedules = await listSchedules();
	const s = schedules.find((x) => Number(x.id) === key);
	const nowRegistered = s ? register(s) : false;
	return { stoppedLiveTask: existing !== undefined, nowRegistered };
}

export function listActiveSchedules(): number[] {
	return Array.from(tasks.keys());
}

export function stopAllSchedules(): void {
	for (const [, task] of tasks) task.stop();
	tasks.clear();
}
