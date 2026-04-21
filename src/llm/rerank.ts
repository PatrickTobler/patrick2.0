import { streamSimple } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { log } from "../log.ts";
import { chooseModel } from "./router.ts";

/**
 * Cross-encoder-style re-rank via a cheap LLM call. Pass a query + candidates, get back
 * the candidates re-ordered by relevance (and optionally truncated).
 *
 * Cheap model (gemini-2.5-flash) — single call, tight prompt.
 * Only worth using when candidates.length > topK + a few; otherwise just take the top-K
 * by whatever scored them originally.
 */
export async function rerankByRelevance<T extends { id: number | string; text?: string }>(
	query: string,
	candidates: T[],
	topK: number,
): Promise<T[]> {
	if (candidates.length <= topK) return candidates;

	const lines = candidates.map((c) => {
		const t = c.text ?? JSON.stringify(c);
		return `${c.id}: ${t.slice(0, 300)}`;
	});

	const cfg = getConfig();
	const model = chooseModel("cheap", cfg.openrouterApiKey);

	const systemPrompt = `You rank candidates by relevance to a query. Return STRICT JSON: {"ids": [<id>, <id>, ...]} in order of most-to-least relevant. Return at most ${topK} ids. No prose.`;

	const userMessage = `Query: ${query}\n\nCandidates:\n${lines.join("\n")}\n\nReturn the ${topK} most relevant ids in order, as JSON.`;

	let acc = "";
	try {
		const stream = await streamSimple(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: cfg.openrouterApiKey },
		);
		for await (const ev of stream) {
			if (ev.type === "text_delta") acc += ev.delta;
		}
	} catch (err) {
		log.warn({ err }, "rerank LLM call failed — falling back to original order");
		return candidates.slice(0, topK);
	}

	const ids = extractIdList(acc);
	if (!ids) {
		log.warn({ acc: acc.slice(0, 200) }, "rerank returned non-json — falling back");
		return candidates.slice(0, topK);
	}

	const byId = new Map<string, T>();
	for (const c of candidates) byId.set(String(c.id), c);

	const ordered: T[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const key = String(id);
		if (seen.has(key)) continue;
		const c = byId.get(key);
		if (c) {
			ordered.push(c);
			seen.add(key);
			if (ordered.length >= topK) break;
		}
	}
	if (ordered.length === 0) return candidates.slice(0, topK);
	return ordered;
}

function extractIdList(raw: string): (string | number)[] | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const candidates = [trimmed];
	const braceMatch = trimmed.match(/\{[\s\S]*\}/);
	if (braceMatch) candidates.push(braceMatch[0]);
	for (const c of candidates) {
		try {
			const parsed = JSON.parse(c) as { ids?: unknown };
			if (Array.isArray(parsed.ids)) {
				return parsed.ids.filter((x): x is string | number => typeof x === "string" || typeof x === "number");
			}
		} catch {
			/* try next */
		}
	}
	return null;
}
