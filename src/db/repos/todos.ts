import { query } from "../pool.ts";

export interface TodoRow {
	id: number;
	text: string;
	due_at: Date | null;
	completed_at: Date | null;
	snoozed_until: Date | null;
	created_at: Date;
}

export async function insertTodo(text: string, dueAt: Date | null): Promise<TodoRow> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("todo text is empty");
	const res = await query<TodoRow>("insert into todos (text, due_at) values ($1, $2) returning *", [trimmed, dueAt]);
	const row = res.rows[0];
	if (!row) throw new Error("insertTodo returned no row");
	return row;
}

export interface ListFilter {
	includeCompleted?: boolean;
	dueWithinHours?: number;
	limit?: number;
}

export async function listTodos(filter: ListFilter = {}): Promise<TodoRow[]> {
	const { includeCompleted = false, dueWithinHours, limit = 100 } = filter;
	const conditions: string[] = [];
	const params: unknown[] = [];
	let i = 1;
	if (!includeCompleted) conditions.push("completed_at is null");
	if (dueWithinHours != null) {
		conditions.push(`(due_at is null or due_at <= now() + ($${i++} || ' hours')::interval)`);
		params.push(String(dueWithinHours));
	}
	const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
	params.push(limit);
	const sql = `select * from todos ${where} order by completed_at nulls first, due_at nulls last, created_at limit $${i}`;
	const res = await query<TodoRow>(sql, params);
	return res.rows;
}

export async function completeTodo(id: number): Promise<TodoRow | null> {
	const res = await query<TodoRow>(
		"update todos set completed_at = now() where id = $1 and completed_at is null returning *",
		[id],
	);
	return res.rows[0] ?? null;
}

export async function snoozeTodo(id: number, until: Date): Promise<TodoRow | null> {
	const res = await query<TodoRow>(
		"update todos set snoozed_until = $2, due_at = greatest(due_at, $2) where id = $1 returning *",
		[id, until],
	);
	return res.rows[0] ?? null;
}

export async function deleteTodo(id: number): Promise<boolean> {
	const res = await query("delete from todos where id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}
