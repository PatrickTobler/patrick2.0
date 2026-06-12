import { query } from "../pool.ts";

export interface ScheduleRow {
	id: number;
	cron: string;
	timezone: string;
	prompt: string;
	enabled: boolean;
	/** Comma-separated tool-group names (see TOOL_GROUPS); null = full tool surface. */
	tools: string | null;
	/** Model class for runs (see ModelClass in llm/router.ts); null = economy. */
	model_class: string | null;
	/** Auto-disable after the first successful fire (reminders). */
	one_shot: boolean;
	last_fired_at: Date | null;
	created_at: Date;
}

export async function insertSchedule(input: {
	cron: string;
	prompt: string;
	timezone?: string;
	tools?: string;
	modelClass?: string;
	oneShot?: boolean;
}): Promise<ScheduleRow> {
	const res = await query<ScheduleRow>(
		"insert into schedules (cron, prompt, timezone, tools, model_class, one_shot) values ($1, $2, $3, $4, $5, $6) returning *",
		[
			input.cron,
			input.prompt,
			input.timezone ?? "Europe/Zurich",
			input.tools ?? null,
			input.modelClass ?? null,
			input.oneShot ?? false,
		],
	);
	const row = res.rows[0];
	if (!row) throw new Error("insertSchedule returned no row");
	return row;
}

export async function listSchedules(): Promise<ScheduleRow[]> {
	const res = await query<ScheduleRow>("select * from schedules order by id");
	return res.rows;
}

export async function getSchedule(id: number): Promise<ScheduleRow | null> {
	const res = await query<ScheduleRow>("select * from schedules where id = $1", [id]);
	return res.rows[0] ?? null;
}

export async function updateSchedule(
	id: number,
	patch: {
		cron?: string;
		prompt?: string;
		timezone?: string;
		enabled?: boolean;
		tools?: string | null;
		modelClass?: string | null;
		oneShot?: boolean;
	},
): Promise<ScheduleRow | null> {
	const fields: string[] = [];
	const params: unknown[] = [id];
	let i = 2;
	if (patch.cron !== undefined) {
		fields.push(`cron = $${i++}`);
		params.push(patch.cron);
	}
	if (patch.prompt !== undefined) {
		fields.push(`prompt = $${i++}`);
		params.push(patch.prompt);
	}
	if (patch.timezone !== undefined) {
		fields.push(`timezone = $${i++}`);
		params.push(patch.timezone);
	}
	if (patch.enabled !== undefined) {
		fields.push(`enabled = $${i++}`);
		params.push(patch.enabled);
	}
	if (patch.tools !== undefined) {
		fields.push(`tools = $${i++}`);
		params.push(patch.tools);
	}
	if (patch.modelClass !== undefined) {
		fields.push(`model_class = $${i++}`);
		params.push(patch.modelClass);
	}
	if (patch.oneShot !== undefined) {
		fields.push(`one_shot = $${i++}`);
		params.push(patch.oneShot);
	}
	if (fields.length === 0) return getSchedule(id);
	const res = await query<ScheduleRow>(`update schedules set ${fields.join(", ")} where id = $1 returning *`, params);
	return res.rows[0] ?? null;
}

export async function deleteSchedule(id: number): Promise<boolean> {
	const res = await query("delete from schedules where id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}

export async function markFired(id: number): Promise<void> {
	await query("update schedules set last_fired_at = now() where id = $1", [id]);
}
