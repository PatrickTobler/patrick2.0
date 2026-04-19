import { embed, vectorLiteral } from "../../llm/embeddings.ts";
import { log } from "../../log.ts";
import { query } from "../pool.ts";

export type Role = "user" | "assistant" | "tool";

export interface MessageRow {
	id: number;
	chat_id: number;
	role: Role;
	content: string;
	tool_calls: unknown;
	tool_call_id: string | null;
	token_count: number | null;
	raw_message: unknown;
	created_at: Date;
}

export interface SearchedMessage extends MessageRow {
	similarity: number;
}

export interface InsertMessage {
	chatId: number;
	role: Role;
	content: string;
	toolCalls?: unknown;
	toolCallId?: string;
	tokenCount?: number;
	rawMessage?: unknown;
}

export async function insertMessage(m: InsertMessage): Promise<MessageRow> {
	const res = await query<MessageRow>(
		`insert into messages (chat_id, role, content, tool_calls, tool_call_id, token_count, raw_message)
		 values ($1, $2, $3, $4, $5, $6, $7)
		 returning *`,
		[
			m.chatId,
			m.role,
			m.content,
			m.toolCalls ? JSON.stringify(m.toolCalls) : null,
			m.toolCallId ?? null,
			m.tokenCount ?? null,
			m.rawMessage ? JSON.stringify(m.rawMessage) : null,
		],
	);
	const row = res.rows[0];
	if (!row) throw new Error("insertMessage returned no row");
	if (m.role === "user" || m.role === "assistant") {
		void embedMessageInBackground(row.id, m.content);
	}
	return row;
}

async function embedMessageInBackground(id: number, content: string): Promise<void> {
	try {
		const vec = await embed(content);
		if (!vec) return;
		await query("update messages set embedding = $1::vector where id = $2", [vectorLiteral(vec), id]);
	} catch (err) {
		log.warn({ err, id }, "background message embedding failed");
	}
}

export async function loadRecent(chatId: number, limit = 50): Promise<MessageRow[]> {
	const res = await query<MessageRow>("select * from messages where chat_id = $1 order by created_at desc limit $2", [
		chatId,
		limit,
	]);
	return res.rows.reverse();
}

export async function searchHistory(queryText: string, limit = 5): Promise<SearchedMessage[]> {
	const vec = await embed(queryText);
	if (!vec) return [];
	const res = await query<MessageRow & { distance: number }>(
		"select *, embedding <=> $1::vector as distance from messages where embedding is not null order by embedding <=> $1::vector limit $2",
		[vectorLiteral(vec), limit],
	);
	return res.rows.map(({ distance, ...row }) => ({ ...row, similarity: 1 - distance }));
}
