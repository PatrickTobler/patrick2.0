import "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { upsertFact } from "../db/repos/facts.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";

const EXTRACTION_PROMPT = `Extract stable, durable facts about Patrick from the message below. Only return facts that are likely to remain true for months — preferences, relationships, habits, recurring contexts, settled opinions.

Skip:
- Ephemeral state ("I'm tired today", "I just had coffee")
- Evolving thinking or in-progress positions (those go to thinking dumps, not facts)
- Anything trivial or one-off
- Facts already obvious from being Patrick (e.g. "Patrick uses Telegram")

Return STRICT JSON: {"facts": ["fact 1", "fact 2"]}. Each fact written in third person about Patrick. Empty array if nothing qualifies. NO other text.`;

interface ExtractionResponse {
	facts: string[];
}

export async function extractFacts(message: string): Promise<string[]> {
	const cfg = getConfig();
	const model = chooseModel("fast", cfg.openrouterApiKey);
	let acc = "";
	const stream = await streamSimple(
		model,
		{
			systemPrompt: EXTRACTION_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }],
			tools: [],
		},
		{ apiKey: cfg.openrouterApiKey },
	);
	for await (const ev of stream) {
		if (ev.type === "text_delta") acc += ev.delta;
	}
	const json = parseJsonLoose(acc);
	if (!json) {
		log.warn({ acc }, "fact extractor returned non-json");
		return [];
	}
	const facts = (json as ExtractionResponse).facts;
	if (!Array.isArray(facts)) return [];
	return facts.map((f) => String(f).trim()).filter((f) => f.length > 0 && f.length < 500);
}

function parseJsonLoose(s: string): unknown {
	const trimmed = s.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		const m = trimmed.match(/\{[\s\S]*\}/);
		if (!m) return null;
		try {
			return JSON.parse(m[0]);
		} catch {
			return null;
		}
	}
}

export async function ingestFactsFromMessage(text: string): Promise<number> {
	try {
		const facts = await extractFacts(text);
		if (facts.length === 0) return 0;
		let stored = 0;
		for (const f of facts) {
			try {
				await upsertFact(f, "auto-extract");
				stored++;
			} catch (err) {
				log.warn({ err, fact: f }, "failed to upsert extracted fact");
			}
		}
		log.info({ stored, candidates: facts.length }, "facts ingested");
		return stored;
	} catch (err) {
		log.error({ err }, "fact extraction failed");
		return 0;
	}
}
