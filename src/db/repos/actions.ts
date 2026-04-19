import { query } from "../pool.ts";

export type Outcome = "pending" | "accepted" | "rejected" | "edited" | "errored";

export interface ActionRow {
	id: number;
	tool: string;
	input: unknown;
	output: unknown;
	outcome: Outcome | null;
	error: string | null;
	created_at: Date;
	resolved_at: Date | null;
}

export interface InsertAction {
	tool: string;
	input: unknown;
}

export async function insertPendingAction(a: InsertAction): Promise<ActionRow> {
	const res = await query<ActionRow>(
		"insert into memory_actions (tool, input, outcome) values ($1, $2, 'pending') returning *",
		[a.tool, JSON.stringify(a.input)],
	);
	const row = res.rows[0];
	if (!row) throw new Error("insertPendingAction returned no row");
	return row;
}

export async function resolveAction(id: number, outcome: Outcome, output: unknown, error?: string): Promise<void> {
	await query("update memory_actions set outcome = $2, output = $3, error = $4, resolved_at = now() where id = $1", [
		id,
		outcome,
		output === undefined ? null : JSON.stringify(output),
		error ?? null,
	]);
}

export async function listRecentActions(limit = 50): Promise<ActionRow[]> {
	const res = await query<ActionRow>("select * from memory_actions order by created_at desc limit $1", [limit]);
	return res.rows;
}

export async function listActionsByOutcome(outcome: Outcome, limit = 50): Promise<ActionRow[]> {
	const res = await query<ActionRow>(
		"select * from memory_actions where outcome = $1 order by created_at desc limit $2",
		[outcome, limit],
	);
	return res.rows;
}

export async function listActionsByTool(tool: string, limit = 50): Promise<ActionRow[]> {
	const res = await query<ActionRow>("select * from memory_actions where tool = $1 order by created_at desc limit $2", [
		tool,
		limit,
	]);
	return res.rows;
}
