import "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { upsertFact } from "../db/repos/facts.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";

const EXTRACTION_PROMPT = `Extract HIGH-SIGNAL stable facts about Patrick from the message below. Be ruthlessly conservative — most messages contain ZERO new facts worth keeping.

Only return facts that pass ALL these tests:
1. Likely to remain true for 6+ months (settled, not in flux)
2. Specific (not generic platitudes; "Patrick uses Linear" — too generic. "Patrick triages Linear weekly on Friday afternoons" — specific.)
3. Non-obvious (not derivable from the bot's setup or generic Patrick knowledge — skip "Patrick uses Telegram", "Patrick has a vault", "Patrick has scheduled prompts")
4. New (you must be ≥80% sure this isn't already known)
5. About Patrick himself (not about the bot, the schedule, masumi network, etc.)

Skip:
- Ephemeral state ("I'm tired today", "I just had coffee", "I'm working on X this week")
- Evolving thinking or in-progress positions (those go to thinking dumps via store_thinking)
- Operational/bot facts ("Patrick has a morning brief schedule", "Patrick uses masumi-agent-messenger CLI")
- Restatements of things mentioned in the prompt itself (a scheduled prompt mentioning "check my emails" doesn't make "Patrick checks emails" a fact)
- Anything trivial or one-off

Hard limit: MAX 3 facts per message. If unsure, return fewer or zero.

Return STRICT JSON: {"facts": ["fact 1", "fact 2"]}. Each fact written in third person about Patrick. Empty array if nothing qualifies. NO other text.`;

interface ExtractionResponse {
	facts: string[];
}

export async function extractFacts(message: string): Promise<string[]> {
	const cfg = getConfig();
	const model = chooseModel("economy", cfg.openrouterApiKey);
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

/** Quick filter — skip the LLM call for messages that obviously contain no extractable facts. */
function isLikelyNoFact(text: string): boolean {
	const trimmed = text.trim();
	// Too short to carry signal
	if (trimmed.length < 30) return true;
	// Common conversational filler / acknowledgements
	const lower = trimmed.toLowerCase();
	const fillerPatterns = [
		/^(ok|okay|cool|nice|great|thanks|thank you|thx|ty|yes|no|sure|alright|alrighty|fine|yep|nope|got it|kk)[!.\s]*$/,
		/^(send|send it|send that|do it|do that|go|go ahead|approve|approved)[!.\s]*$/,
		/^\?\?+$/,
		/^[\s\d.,!?]+$/, // pure punctuation/numbers
	];
	return fillerPatterns.some((re) => re.test(lower));
}

export async function ingestFactsFromMessage(text: string): Promise<number> {
	if (isLikelyNoFact(text)) return 0;
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
