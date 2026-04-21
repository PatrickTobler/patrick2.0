import { embed, vectorLiteral } from "../../llm/embeddings.ts";
import { query } from "../pool.ts";

export interface FactRow {
	id: number;
	text: string;
	source: string | null;
	confidence: number;
	created_at: Date;
	updated_at: Date;
}

export interface RecalledFact extends FactRow {
	similarity: number;
}

const DEDUPE_THRESHOLD = 0.85;

// Hybrid recall weights: cosine similarity vs BM25 text rank
const COSINE_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

export async function upsertFact(text: string, source: string | null): Promise<FactRow> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("fact text is empty");

	const vec = await embed(trimmed);
	if (vec) {
		const dupe = await query<FactRow & { distance: number }>(
			"select *, embedding <=> $1::vector as distance from memory_facts where embedding is not null order by embedding <=> $1::vector limit 1",
			[vectorLiteral(vec)],
		);
		const top = dupe.rows[0];
		if (top && 1 - top.distance >= DEDUPE_THRESHOLD) {
			const keepLonger = trimmed.length > top.text.length;
			const updated = await query<FactRow>(
				keepLonger
					? "update memory_facts set text = $2, embedding = $3::vector, confidence = least(confidence + 0.1, 5.0), updated_at = now() where id = $1 returning *"
					: "update memory_facts set confidence = least(confidence + 0.1, 5.0), updated_at = now() where id = $1 returning *",
				keepLonger ? [top.id, trimmed, vectorLiteral(vec)] : [top.id],
			);
			const row = updated.rows[0];
			if (!row) throw new Error("upsertFact failed to update existing row");
			return row;
		}
	}

	const inserted = await query<FactRow>(
		"insert into memory_facts (text, embedding, source) values ($1, $2::vector, $3) returning *",
		[trimmed, vec ? vectorLiteral(vec) : null, source],
	);
	const row = inserted.rows[0];
	if (!row) throw new Error("upsertFact returned no row");
	return row;
}

/** Hybrid recall: cosine similarity + BM25 text rank, weighted. */
export async function recallFacts(queryText: string, limit = 5): Promise<RecalledFact[]> {
	const vec = await embed(queryText);
	if (!vec) return [];
	const res = await query<FactRow & { hybrid_score: number; cosine_sim: number }>(
		`select *,
		        (1 - (embedding <=> $1::vector)) as cosine_sim,
		        ts_rank(tsv, plainto_tsquery('english', $2)) as text_rank,
		        (1 - (embedding <=> $1::vector)) * $3
		          + coalesce(ts_rank(tsv, plainto_tsquery('english', $2)), 0) * $4
		          as hybrid_score
		 from memory_facts
		 where embedding is not null
		 order by hybrid_score desc
		 limit $5`,
		[vectorLiteral(vec), queryText, COSINE_WEIGHT, BM25_WEIGHT, limit],
	);
	return res.rows.map((row) => ({ ...row, similarity: row.cosine_sim }));
}

export interface ListFactsFilter {
	offset?: number;
	limit?: number;
	/** Plain-text substring search over fact text (case-insensitive). */
	search?: string;
	/** Minimum confidence (inclusive). */
	minConfidence?: number;
	/** Only facts updated in the last N days. */
	sinceDays?: number;
}

export async function listFacts(filter: ListFactsFilter = {}): Promise<FactRow[]> {
	const { offset = 0, limit = 100, search, minConfidence, sinceDays } = filter;
	const conditions: string[] = [];
	const params: unknown[] = [];
	let i = 1;
	if (search?.trim()) {
		conditions.push(`text ilike $${i++}`);
		params.push(`%${search.trim()}%`);
	}
	if (minConfidence != null) {
		conditions.push(`confidence >= $${i++}`);
		params.push(minConfidence);
	}
	if (sinceDays != null) {
		conditions.push(`updated_at >= now() - ($${i++} || ' days')::interval`);
		params.push(String(sinceDays));
	}
	const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
	params.push(limit, offset);
	const sql = `select * from memory_facts ${where} order by updated_at desc limit $${i++} offset $${i}`;
	const res = await query<FactRow>(sql, params);
	return res.rows;
}

export async function deleteFact(id: number): Promise<boolean> {
	const res = await query("delete from memory_facts where id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}

export async function countFacts(filter: ListFactsFilter = {}): Promise<number> {
	const { search, minConfidence, sinceDays } = filter;
	const conditions: string[] = [];
	const params: unknown[] = [];
	let i = 1;
	if (search?.trim()) {
		conditions.push(`text ilike $${i++}`);
		params.push(`%${search.trim()}%`);
	}
	if (minConfidence != null) {
		conditions.push(`confidence >= $${i++}`);
		params.push(minConfidence);
	}
	if (sinceDays != null) {
		conditions.push(`updated_at >= now() - ($${i++} || ' days')::interval`);
		params.push(String(sinceDays));
	}
	const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
	const res = await query<{ count: string }>(`select count(*)::text as count from memory_facts ${where}`, params);
	return Number(res.rows[0]?.count ?? 0);
}
