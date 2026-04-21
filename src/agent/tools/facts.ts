import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { deleteFact, listFacts, upsertFact } from "../../db/repos/facts.ts";

const RememberSchema = Type.Object({
	text: Type.String({
		description: "The fact, written in third person about Patrick. Concise.",
		minLength: 3,
		maxLength: 500,
	}),
});

export const rememberFactTool: AgentTool<typeof RememberSchema> = {
	name: "remember_fact",
	label: "Remember a fact",
	description:
		"Store a durable fact about Patrick (preferences, relationships, settled habits or opinions). Use when Patrick says 'remember that X' or shares something stable worth keeping. Skip ephemeral state and evolving thoughts.",
	parameters: RememberSchema,
	execute: async (_id, { text }: Static<typeof RememberSchema>) => {
		const fact = await upsertFact(text, "agent-tool");
		const summary = `Stored fact #${fact.id}: ${fact.text}`;
		return {
			content: [{ type: "text", text: summary }],
			details: { id: fact.id, text: fact.text, confidence: fact.confidence },
		};
	},
};

const ListSchema = Type.Object({
	limit: Type.Optional(Type.Number({ description: "Max facts to return.", minimum: 1, maximum: 500, default: 50 })),
	offset: Type.Optional(
		Type.Number({ description: "Pagination offset (for audits of large fact stores).", minimum: 0, default: 0 }),
	),
	search: Type.Optional(
		Type.String({
			description: "Case-insensitive substring filter over fact text. E.g. 'work' finds facts mentioning work.",
			maxLength: 200,
		}),
	),
	min_confidence: Type.Optional(
		Type.Number({
			description: "Only facts with confidence >= this. Use 2.0+ to filter to reinforced facts.",
			minimum: 0,
			maximum: 5,
		}),
	),
	since_days: Type.Optional(
		Type.Number({ description: "Only facts updated in the last N days. 7 = last week.", minimum: 1, maximum: 365 }),
	),
});

export const listFactsTool: AgentTool<typeof ListSchema> = {
	name: "list_facts",
	label: "List stored facts",
	description:
		"List facts stored about Patrick with optional filters (search, min_confidence, since_days) and pagination. Use for 'what do you know about me', audits, or exploring the memory. Combine filters to narrow down: search='work' + min_confidence=2 surfaces reinforced work-related facts.",
	parameters: ListSchema,
	execute: async (_id, params: Static<typeof ListSchema>) => {
		const facts = await listFacts({
			limit: params.limit ?? 50,
			offset: params.offset ?? 0,
			...(params.search ? { search: params.search } : {}),
			...(params.min_confidence != null ? { minConfidence: params.min_confidence } : {}),
			...(params.since_days != null ? { sinceDays: params.since_days } : {}),
		});
		if (facts.length === 0) {
			return { content: [{ type: "text", text: "No facts match." }], details: { facts: [] } };
		}
		const lines = facts.map((f) => `${f.id}. (c${f.confidence.toFixed(1)}) ${f.text}`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { facts: facts.map((f) => ({ id: f.id, text: f.text, confidence: f.confidence })) },
		};
	},
};

const ForgetSchema = Type.Object({
	id: Type.Number({ description: "Fact id to delete.", minimum: 1 }),
});

export const forgetFactTool: AgentTool<typeof ForgetSchema> = {
	name: "forget_fact",
	label: "Forget a fact",
	description:
		"Delete a stored fact by id. Use when Patrick asks to forget something or corrects a wrong fact. Look up the id via list_facts first if not given.",
	parameters: ForgetSchema,
	execute: async (_id, { id }: Static<typeof ForgetSchema>) => {
		const ok = await deleteFact(id);
		const text = ok ? `Forgot fact #${id}.` : `No fact #${id} found.`;
		return { content: [{ type: "text", text }], details: { id, deleted: ok } };
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const factTools: AgentTool<any>[] = [rememberFactTool, listFactsTool, forgetFactTool];
