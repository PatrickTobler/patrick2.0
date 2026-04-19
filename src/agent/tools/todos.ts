import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { type TodoRow, completeTodo, deleteTodo, insertTodo, listTodos, snoozeTodo } from "../../db/repos/todos.ts";

function parseDueAt(raw: string | undefined): Date | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const direct = new Date(trimmed);
	if (!Number.isNaN(direct.getTime())) return direct;
	throw new Error(`Could not parse due_at "${raw}". Use ISO 8601 like "2026-04-20T09:00:00Z".`);
}

function fmtTodo(t: TodoRow): string {
	const status = t.completed_at ? "✓" : "·";
	const due = t.due_at ? ` (due ${t.due_at.toISOString().slice(0, 16).replace("T", " ")})` : "";
	return `${status} ${t.id}. ${t.text}${due}`;
}

const AddSchema = Type.Object({
	text: Type.String({ description: "What needs doing. Plain text, brief.", minLength: 1, maxLength: 500 }),
	due_at: Type.Optional(
		Type.String({
			description:
				"Due time in ISO 8601 (e.g. '2026-04-20T18:00:00Z'). Convert relative phrases ('tomorrow 6pm', 'in 3 hours') to absolute UTC yourself before passing — use the current_time tool first if needed. Omit if no due time.",
			maxLength: 40,
		}),
	),
});

export const addTodoTool: AgentTool<typeof AddSchema> = {
	name: "add_todo",
	label: "Add a todo",
	description:
		"Capture a task Patrick needs to do. Use whenever he says 'remind me to X', 'add to my list', 'todo: Y', or implies an action item. Always pass an absolute ISO 8601 due_at if Patrick mentions any time at all.",
	parameters: AddSchema,
	execute: async (_id, { text, due_at }: Static<typeof AddSchema>) => {
		const dueAt = parseDueAt(due_at);
		const row = await insertTodo(text, dueAt);
		return { content: [{ type: "text", text: `Added: ${fmtTodo(row)}` }], details: { id: row.id } };
	},
};

const ListSchema = Type.Object({
	include_completed: Type.Optional(Type.Boolean({ description: "Include completed todos.", default: false })),
	due_within_hours: Type.Optional(
		Type.Number({ description: "Only todos due within N hours (or with no due date).", minimum: 1, maximum: 8760 }),
	),
	limit: Type.Optional(Type.Number({ description: "Max todos.", minimum: 1, maximum: 200, default: 50 })),
});

export const listTodosTool: AgentTool<typeof ListSchema> = {
	name: "list_todos",
	label: "List todos",
	description:
		"List Patrick's open todos (newest due first). Filter by 'due within N hours' for 'what's on my plate today'. Set include_completed=true for an audit of recent done items.",
	parameters: ListSchema,
	execute: async (_id, params: Static<typeof ListSchema>) => {
		const rows = await listTodos({
			includeCompleted: params.include_completed ?? false,
			...(params.due_within_hours != null ? { dueWithinHours: params.due_within_hours } : {}),
			limit: params.limit ?? 50,
		});
		if (rows.length === 0) {
			return { content: [{ type: "text", text: "No matching todos." }], details: { count: 0 } };
		}
		return {
			content: [{ type: "text", text: rows.map(fmtTodo).join("\n") }],
			details: { count: rows.length },
		};
	},
};

const CompleteSchema = Type.Object({
	id: Type.Number({ description: "Todo id to mark done.", minimum: 1 }),
});

export const completeTodoTool: AgentTool<typeof CompleteSchema> = {
	name: "complete_todo",
	label: "Complete a todo",
	description:
		"Mark a todo done. Use when Patrick says 'I did X' or 'mark Y done'. Use list_todos first to find the id if not given.",
	parameters: CompleteSchema,
	execute: async (_id, { id }: Static<typeof CompleteSchema>) => {
		const row = await completeTodo(id);
		if (!row) {
			return {
				content: [{ type: "text", text: `Todo #${id} not found or already completed.` }],
				details: { id, ok: false },
			};
		}
		return { content: [{ type: "text", text: `Done: ${fmtTodo(row)}` }], details: { id, ok: true } };
	},
};

const SnoozeSchema = Type.Object({
	id: Type.Number({ description: "Todo id to snooze.", minimum: 1 }),
	until: Type.String({
		description: "ISO 8601 timestamp to snooze until. Convert relative phrases yourself.",
		maxLength: 40,
	}),
});

export const snoozeTodoTool: AgentTool<typeof SnoozeSchema> = {
	name: "snooze_todo",
	label: "Snooze a todo",
	description:
		"Push a todo's due date to a later time. Use when Patrick says 'remind me about X tomorrow instead' or similar.",
	parameters: SnoozeSchema,
	execute: async (_id, { id, until }: Static<typeof SnoozeSchema>) => {
		const date = parseDueAt(until);
		if (!date) throw new Error("snooze_until is required");
		const row = await snoozeTodo(id, date);
		if (!row) return { content: [{ type: "text", text: `Todo #${id} not found.` }], details: { id, ok: false } };
		return { content: [{ type: "text", text: `Snoozed: ${fmtTodo(row)}` }], details: { id, ok: true } };
	},
};

const DeleteSchema = Type.Object({
	id: Type.Number({ description: "Todo id to delete.", minimum: 1 }),
});

export const deleteTodoTool: AgentTool<typeof DeleteSchema> = {
	name: "delete_todo",
	label: "Delete a todo",
	description:
		"Remove a todo entirely. Use when Patrick says 'cancel that' or wants to clean up — not for completion (use complete_todo).",
	parameters: DeleteSchema,
	execute: async (_id, { id }: Static<typeof DeleteSchema>) => {
		const ok = await deleteTodo(id);
		return {
			content: [{ type: "text", text: ok ? `Deleted #${id}.` : `Todo #${id} not found.` }],
			details: { id, ok },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const todoTools: AgentTool<any>[] = [
	addTodoTool,
	listTodosTool,
	completeTodoTool,
	snoozeTodoTool,
	deleteTodoTool,
];
