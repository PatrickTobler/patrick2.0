import { vectorLiteral } from "../../llm/embeddings.ts";
import { query } from "../pool.ts";

export interface NotifiedItemRow {
	id: number;
	item_key: string;
	urgency: string;
	text: string;
	source: string | null;
	created_at: Date;
}

export interface SimilarNotification {
	text: string;
	created_at: Date;
	similarity: number;
}

export interface QueuedNotificationRow {
	id: number;
	text: string;
	urgency: string;
	deliver_after: Date;
	created_at: Date;
}

export async function findNotifiedByKey(itemKey: string, withinDays: number): Promise<NotifiedItemRow | null> {
	const res = await query<NotifiedItemRow>(
		`select id, item_key, urgency, text, source, created_at
		 from notified_items
		 where item_key = $1 and created_at > now() - ($2 || ' days')::interval
		 order by created_at desc limit 1`,
		[itemKey, withinDays],
	);
	return res.rows[0] ?? null;
}

export async function findSimilarNotification(
	embedding: number[],
	withinDays: number,
	minSimilarity: number,
): Promise<SimilarNotification | null> {
	const res = await query<SimilarNotification>(
		`select text, created_at, (1 - (embedding <=> $1::vector)) as similarity
		 from notified_items
		 where embedding is not null and created_at > now() - ($2 || ' days')::interval
		 order by embedding <=> $1::vector
		 limit 1`,
		[vectorLiteral(embedding), withinDays],
	);
	const row = res.rows[0];
	if (!row || Number(row.similarity) < minSimilarity) return null;
	return { ...row, similarity: Number(row.similarity) };
}

export async function insertNotifiedItem(input: {
	itemKey: string;
	urgency: string;
	text: string;
	source?: string;
	embedding?: number[] | null;
}): Promise<void> {
	await query(
		`insert into notified_items (item_key, urgency, text, source, embedding)
		 values ($1, $2, $3, $4, $5::vector)`,
		[
			input.itemKey,
			input.urgency,
			input.text,
			input.source ?? null,
			input.embedding ? vectorLiteral(input.embedding) : null,
		],
	);
}

export async function enqueueNotification(text: string, urgency: string, deliverAfter: Date): Promise<void> {
	await query("insert into queued_notifications (text, urgency, deliver_after) values ($1, $2, $3)", [
		text,
		urgency,
		deliverAfter,
	]);
}

export async function dueQueuedNotifications(): Promise<QueuedNotificationRow[]> {
	const res = await query<QueuedNotificationRow>(
		`select id, text, urgency, deliver_after, created_at
		 from queued_notifications
		 where delivered_at is null and deliver_after <= now()
		 order by created_at`,
	);
	return res.rows;
}

export async function markNotificationsDelivered(ids: number[]): Promise<void> {
	if (ids.length === 0) return;
	await query("update queued_notifications set delivered_at = now() where id = any($1::bigint[])", [ids]);
}
