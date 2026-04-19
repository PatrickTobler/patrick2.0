import { embed, vectorLiteral } from "../../llm/embeddings.ts";
import { query } from "../pool.ts";

export interface ThinkingRow {
	id: number;
	text: string;
	topics: string[] | null;
	created_at: Date;
}

export interface RecalledThinking extends ThinkingRow {
	similarity: number;
}

export async function insertThinking(text: string, topics: string[] = []): Promise<ThinkingRow> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("thinking text is empty");
	const vec = await embed(trimmed);
	const res = await query<ThinkingRow>(
		"insert into memory_thinking (text, topics, embedding) values ($1, $2, $3::vector) returning *",
		[trimmed, topics.length > 0 ? topics : null, vec ? vectorLiteral(vec) : null],
	);
	const row = res.rows[0];
	if (!row) throw new Error("insertThinking returned no row");
	return row;
}

export async function recallThinking(queryText: string, limit = 5): Promise<RecalledThinking[]> {
	const vec = await embed(queryText);
	if (!vec) return [];
	const res = await query<ThinkingRow & { distance: number }>(
		"select *, embedding <=> $1::vector as distance from memory_thinking where embedding is not null order by embedding <=> $1::vector limit $2",
		[vectorLiteral(vec), limit],
	);
	return res.rows.map(({ distance, ...row }) => ({ ...row, similarity: 1 - distance }));
}

export async function listThinkingByTopic(topic: string, limit = 20): Promise<ThinkingRow[]> {
	const res = await query<ThinkingRow>(
		"select * from memory_thinking where $1 = any(topics) order by created_at desc limit $2",
		[topic, limit],
	);
	return res.rows;
}

export async function listRecentThinking(limit = 20): Promise<ThinkingRow[]> {
	const res = await query<ThinkingRow>("select * from memory_thinking order by created_at desc limit $1", [limit]);
	return res.rows;
}
