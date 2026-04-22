import { getConfig } from "../config.ts";
import { log } from "../log.ts";

export const EMBEDDING_DIMS = 1536;
const MODEL = "openai/text-embedding-3-small";
const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;

export async function embed(text: string): Promise<number[] | null> {
	return (await embedMany([text]))?.[0] ?? null;
}

export async function embedMany(texts: string[]): Promise<number[][] | null> {
	if (texts.length === 0) return [];
	const cfg = getConfig();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
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
				log.warn({ status: res.status, body: body.slice(0, 400), attempt }, "embedding request failed (non-2xx)");
				if (res.status >= 500 && attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
					continue;
				}
				return null;
			}

			// Defensive parse — OpenRouter has been seen returning 200 with missing/empty data
			const raw = await res.text();
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch (err) {
				log.warn({ err, body: raw.slice(0, 400), attempt }, "embedding response not valid JSON");
				if (attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
					continue;
				}
				return null;
			}

			const data = (json as { data?: unknown })?.data;
			if (!Array.isArray(data)) {
				log.warn({ sample: JSON.stringify(json).slice(0, 400), attempt }, "embedding response missing 'data' array");
				if (attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
					continue;
				}
				return null;
			}

			const vectors = data
				.map((d) => (d as { embedding?: unknown })?.embedding)
				.filter((v): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number"));

			if (vectors.length !== texts.length) {
				log.warn({ expected: texts.length, got: vectors.length, attempt }, "embedding count mismatch");
				if (vectors.length === 0 && attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
					continue;
				}
				return vectors.length > 0 ? vectors : null;
			}

			return vectors;
		} catch (err) {
			log.warn({ err, attempt }, "embedding fetch threw");
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * 2 ** attempt));
				continue;
			}
			return null;
		}
	}
	return null;
}

/** Format a vector for pgvector's text input (Postgres). */
export function vectorLiteral(v: number[]): string {
	return `[${v.join(",")}]`;
}
