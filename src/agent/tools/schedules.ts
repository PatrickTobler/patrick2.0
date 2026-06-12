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
import { type ReloadResult, reloadOneSchedule } from "../../scheduler/service.ts";
import { VALID_TOOL_GROUPS } from "../scheduled-runner.ts";

function fmtSchedule(s: ScheduleRow): string {
	const status = s.enabled ? "ON " : "off";
	const last = s.last_fired_at ? ` last:${s.last_fired_at.toISOString().slice(0, 16).replace("T", " ")}` : "";
	const tools = s.tools ? ` tools:[${s.tools}]` : "";
	const promptSnippet = s.prompt.length > 80 ? `${s.prompt.slice(0, 80)}…` : s.prompt;
	return `${s.id} [${status}] "${s.cron}" ${s.timezone}${tools}${last}\n  ${promptSnippet}`;
}

// The live node-cron task and the DB row are separate state — report both so a
// mismatch is visible immediately instead of surfacing as a ghost cron weeks later.
function fmtReload(r: ReloadResult): string {
	return `live task: ${r.stoppedLiveTask ? "stopped old" : "none was running"}, ${r.nowRegistered ? "now registered" : "not registered"}`;
}

function validateToolsSpec(spec: string): void {
	const names = spec
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	const unknown = names.filter((n) => n !== "time" && !VALID_TOOL_GROUPS.includes(n));
	if (unknown.length > 0) {
		throw new Error(`Unknown tool groups: ${unknown.join(", ")}. Valid: ${VALID_TOOL_GROUPS.join(", ")}`);
	}
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
	tools: Type.Optional(
		Type.String({
			description:
				"Comma-separated tool groups this schedule needs (slim profile = cheaper + sharper runs). Omit for the full tool surface. Valid groups: facts, thinking, usage, vault, calendar, gmail, whoop, telegram, shell, skills, actions, mcp, coder, researcher, github, linear, dune, web, moltbook, linkedin. time tools are always included.",
			maxLength: 300,
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
		if (params.tools) validateToolsSpec(params.tools);
		const row = await insertSchedule({
			cron: params.cron,
			prompt: params.prompt,
			...(params.timezone ? { timezone: params.timezone } : {}),
			...(params.tools ? { tools: params.tools } : {}),
		});
		const reload = await reloadOneSchedule(row.id);
		return {
			content: [{ type: "text", text: `Scheduled #${row.id} (${fmtReload(reload)}):\n${fmtSchedule(row)}` }],
			details: { id: row.id, cron: row.cron, timezone: row.timezone, ...reload },
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
	tools: Type.Optional(
		Type.String({
			description:
				"New comma-separated tool-group profile (see add_schedule for valid groups). Pass an empty string to reset to the full tool surface.",
			maxLength: 300,
		}),
	),
});

export const updateScheduleTool: AgentTool<typeof UpdateSchema> = {
	name: "update_schedule",
	label: "Update a schedule",
	description:
		"Edit a schedule's cron, prompt, or timezone. Use when Patrick wants to change WHEN or WHAT a schedule does (without losing history).",
	parameters: UpdateSchema,
	execute: async (_id, { id, cron: cronExpr, prompt, timezone, tools }: Static<typeof UpdateSchema>) => {
		if (cronExpr !== undefined && !cron.validate(cronExpr)) {
			throw new Error(`Invalid cron expression: "${cronExpr}"`);
		}
		if (tools) validateToolsSpec(tools);
		const row = await updateSchedule(id, {
			...(cronExpr !== undefined ? { cron: cronExpr } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(timezone !== undefined ? { timezone } : {}),
			...(tools !== undefined ? { tools: tools.trim() === "" ? null : tools } : {}),
		});
		if (!row) return { content: [{ type: "text", text: `Schedule #${id} not found.` }], details: { id, ok: false } };
		const reload = await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: `Updated (${fmtReload(reload)}):\n${fmtSchedule(row)}` }],
			details: { id, ok: true, ...reload },
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
		const reload = await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: `Paused #${id} (${fmtReload(reload)}).` }],
			details: { id, ok: true, ...reload },
		};
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
		const reload = await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: `Resumed #${id} (${fmtReload(reload)}).` }],
			details: { id, ok: true, ...reload },
		};
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
		const reload = await reloadOneSchedule(id);
		return {
			content: [{ type: "text", text: ok ? `Deleted #${id} (${fmtReload(reload)}).` : `Schedule #${id} not found.` }],
			details: { id, ok, ...reload },
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
