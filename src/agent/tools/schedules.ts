import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import cron from "node-cron";
import {
	type ScheduleRow,
	deleteSchedule,
	insertSchedule,
	listSchedules,
	updateSchedule,
} from "../../db/repos/schedules.ts";
import { reloadOneSchedule } from "../../scheduler/service.ts";

function fmtSchedule(s: ScheduleRow): string {
	const status = s.enabled ? "ON " : "off";
	const last = s.last_fired_at ? ` last:${s.last_fired_at.toISOString().slice(0, 16).replace("T", " ")}` : "";
	const promptSnippet = s.prompt.length > 80 ? `${s.prompt.slice(0, 80)}…` : s.prompt;
	return `${s.id} [${status}] "${s.cron}" ${s.timezone}${last}\n  ${promptSnippet}`;
}

const AddSchema = Type.Object({
	cron: Type.String({
		description:
			"Cron expression (5 fields: 'min hr dom mon dow'). Examples: '0 8 * * 1-5' (weekdays 08:00), '*/30 * * * *' (every 30 min), '0 21 * * *' (daily 21:00).",
		minLength: 9,
		maxLength: 100,
	}),
	prompt: Type.String({
		description:
			"The prompt that will run on each fire. Treat it as instructions to yourself running autonomously. Mention which tools/skills to use. Make clear when to ping Patrick (call send_telegram_message) vs stay silent.",
		minLength: 5,
		maxLength: 4000,
	}),
	timezone: Type.Optional(
		Type.String({
			description: "IANA timezone, default 'Europe/Zurich' (Patrick's tz).",
			maxLength: 50,
		}),
	),
});

export const addScheduleTool: AgentTool<typeof AddSchema> = {
	name: "add_schedule",
	label: "Add a schedule",
	description:
		"Create a new scheduled prompt that fires on a cron schedule. Use when Patrick says 'every morning…', 'check every 30 min if…', 'every Friday at 5pm…', etc. The cron field MUST be a valid 5-field cron expression. Always restate the resolved cron + tz to Patrick after creating.",
	parameters: AddSchema,
	execute: async (_id, params: Static<typeof AddSchema>) => {
		if (!cron.validate(params.cron)) {
			throw new Error(`Invalid cron expression: "${params.cron}"`);
		}
		const row = await insertSchedule({
			cron: params.cron,
			prompt: params.prompt,
			...(params.timezone ? { timezone: params.timezone } : {}),
		});
		await reloadOneSchedule(row.id);
		return {
			content: [{ type: "text", text: `Scheduled #${row.id}:\n${fmtSchedule(row)}` }],
			details: { id: row.id, cron: row.cron, timezone: row.timezone },
		};
	},
};

const ListSchema = Type.Object({});

export const listSchedulesTool: AgentTool<typeof ListSchema> = {
	name: "list_schedules",
	label: "List schedules",
	description: "List all scheduled prompts (enabled and paused).",
	parameters: ListSchema,
	execute: async () => {
		const rows = await listSchedules();
		if (rows.length === 0) return { content: [{ type: "text", text: "No schedules." }], details: { count: 0 } };
		return {
			content: [{ type: "text", text: rows.map(fmtSchedule).join("\n\n") }],
			details: { count: rows.length },
		};
	},
};

const UpdateSchema = Type.Object({
	id: Type.Number({ description: "Schedule id from list_schedules.", minimum: 1 }),
	cron: Type.Optional(Type.String({ description: "New cron expression.", maxLength: 100 })),
	prompt: Type.Optional(Type.String({ description: "New prompt body.", maxLength: 4000 })),
	timezone: Type.Optional(Type.String({ description: "New IANA timezone.", maxLength: 50 })),
});

export const updateScheduleTool: AgentTool<typeof UpdateSchema> = {
	name: "update_schedule",
	label: "Update a schedule",
	description:
		"Edit a schedule's cron, prompt, or timezone. Use when Patrick wants to change WHEN or WHAT a schedule does (without losing history).",
	parameters: UpdateSchema,
	execute: async (_id, { id, cron: cronExpr, prompt, timezone }: Static<typeof UpdateSchema>) => {
		if (cronExpr !== undefined && !cron.validate(cronExpr)) {
			throw new Error(`Invalid cron expression: "${cronExpr}"`);
		}
		const row = await updateSchedule(id, {
			...(cronExpr !== undefined ? { cron: cronExpr } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(timezone !== undefined ? { timezone } : {}),
		});
		if (!row) return { content: [{ type: "text", text: `Schedule #${id} not found.` }], details: { id, ok: false } };
		await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: `Updated:\n${fmtSchedule(row)}` }],
			details: { id, ok: true },
		};
	},
};

const PauseSchema = Type.Object({
	id: Type.Number({ description: "Schedule id.", minimum: 1 }),
});

export const pauseScheduleTool: AgentTool<typeof PauseSchema> = {
	name: "pause_schedule",
	label: "Pause a schedule",
	description: "Disable a schedule without deleting it. Use 'pause' or 'stop X for now' from Patrick.",
	parameters: PauseSchema,
	execute: async (_id, { id }: Static<typeof PauseSchema>) => {
		const row = await updateSchedule(id, { enabled: false });
		if (!row) return { content: [{ type: "text", text: `Schedule #${id} not found.` }], details: { id, ok: false } };
		await reloadOneSchedule(id);
		return { content: [{ type: "text", text: `Paused #${id}.` }], details: { id, ok: true } };
	},
};

export const resumeScheduleTool: AgentTool<typeof PauseSchema> = {
	name: "resume_schedule",
	label: "Resume a schedule",
	description: "Re-enable a paused schedule.",
	parameters: PauseSchema,
	execute: async (_id, { id }: Static<typeof PauseSchema>) => {
		const row = await updateSchedule(id, { enabled: true });
		if (!row) return { content: [{ type: "text", text: `Schedule #${id} not found.` }], details: { id, ok: false } };
		await reloadOneSchedule(id);
		return { content: [{ type: "text", text: `Resumed #${id}.` }], details: { id, ok: true } };
	},
};

const DeleteSchema = Type.Object({
	id: Type.Number({ description: "Schedule id.", minimum: 1 }),
});

export const deleteScheduleTool: AgentTool<typeof DeleteSchema> = {
	name: "delete_schedule",
	label: "Delete a schedule",
	description:
		"Permanently remove a schedule. Use only when Patrick wants it gone — for temporary stops use pause_schedule.",
	parameters: DeleteSchema,
	execute: async (_id, { id }: Static<typeof DeleteSchema>) => {
		const ok = await deleteSchedule(id);
		await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: ok ? `Deleted #${id}.` : `Schedule #${id} not found.` }],
			details: { id, ok },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const scheduleTools: AgentTool<any>[] = [
	addScheduleTool,
	listSchedulesTool,
	updateScheduleTool,
	pauseScheduleTool,
	resumeScheduleTool,
	deleteScheduleTool,
];
