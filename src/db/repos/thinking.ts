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

const COSINE_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

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
	const res = await query<ThinkingRow & { hybrid_score: number; cosine_sim: number }>(
		`select *,
		        (1 - (embedding <=> $1::vector)) as cosine_sim,
		        ts_rank(tsv, plainto_tsquery('english', $2)) as text_rank,
		        (1 - (embedding <=> $1::vector)) * $3
		          + coalesce(ts_rank(tsv, plainto_tsquery('english', $2)), 0) * $4
		          as hybrid_score
		 from memory_thinking
		 where embedding is not null
		 order by hybrid_score desc
		 limit $5`,
		[vectorLiteral(vec), queryText, COSINE_WEIGHT, BM25_WEIGHT, limit],
	);
	return res.rows.map((row) => ({ ...row, similarity: row.cosine_sim }));
}

export interface ListThinkingFilter {
	offset?: number;
	limit?: number;
	topic?: string;
	search?: string;
	sinceDays?: number;
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

export async function listThinking(filter: ListThinkingFilter = {}): Promise<ThinkingRow[]> {
	const { offset = 0, limit = 50, topic, search, sinceDays } = filter;
	const conditions: string[] = [];
	const params: unknown[] = [];
	let i = 1;
	if (topic) {
		conditions.push(`$${i++} = any(topics)`);
		params.push(topic);
	}
	if (search?.trim()) {
		conditions.push(`text ilike $${i++}`);
		params.push(`%${search.trim()}%`);
	}
	if (sinceDays != null) {
		conditions.push(`created_at >= now() - ($${i++} || ' days')::interval`);
		params.push(String(sinceDays));
	}
	const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
	params.push(limit, offset);
	const sql = `select * from memory_thinking ${where} order by created_at desc limit $${i++} offset $${i}`;
	const res = await query<ThinkingRow>(sql, params);
	return res.rows;
}
