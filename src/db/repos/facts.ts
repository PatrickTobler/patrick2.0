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
			// Keep the longer, more informative phrasing if the new text is longer than the existing.
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

export async function recallFacts(queryText: string, limit = 5): Promise<RecalledFact[]> {
	const vec = await embed(queryText);
	if (!vec) return [];
	const res = await query<FactRow & { distance: number }>(
		"select *, embedding <=> $1::vector as distance from memory_facts where embedding is not null order by embedding <=> $1::vector limit $2",
		[vectorLiteral(vec), limit],
	);
	return res.rows.map(({ distance, ...row }) => ({ ...row, similarity: 1 - distance }));
}

export async function listFacts(limit = 100): Promise<FactRow[]> {
	const res = await query<FactRow>("select * from memory_facts order by updated_at desc limit $1", [limit]);
	return res.rows;
}

export async function deleteFact(id: number): Promise<boolean> {
	const res = await query("delete from memory_facts where id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}
