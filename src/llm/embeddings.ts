import { getConfig } from "../config.ts";
import { log } from "../log.ts";

export const EMBEDDING_DIMS = 1536;
const MODEL = "openai/text-embedding-3-small";
const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

export async function embed(text: string): Promise<number[] | null> {
	return (await embedMany([text]))?.[0] ?? null;
}

export async function embedMany(texts: string[]): Promise<number[][] | null> {
	if (texts.length === 0) return [];
	const cfg = getConfig();

	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${cfg.openrouterApiKey}`,
			"HTTP-Referer": "https://patrick2.0",
			"X-Title": "patrick2.0",
		},
		body: JSON.stringify({ model: MODEL, input: texts }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		log.error({ status: res.status, body }, "embedding request failed");
		return null;
	}

	const json = (await res.json()) as { data: { embedding: number[] }[] };
	return json.data.map((d) => d.embedding);
}

/** Format a vector for pgvector's text input (Postgres). */
export function vectorLiteral(v: number[]): string {
	return `[${v.join(",")}]`;
}
