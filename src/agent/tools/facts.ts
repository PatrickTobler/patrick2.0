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
	limit: Type.Optional(Type.Number({ description: "Max facts to return.", minimum: 1, maximum: 100, default: 20 })),
});

export const listFactsTool: AgentTool<typeof ListSchema> = {
	name: "list_facts",
	label: "List stored facts",
	description:
		"List facts currently stored about Patrick. Use when Patrick asks 'what do you know about me?' or wants to review/audit memory.",
	parameters: ListSchema,
	execute: async (_id, { limit }: Static<typeof ListSchema>) => {
		const facts = await listFacts(limit ?? 20);
		if (facts.length === 0) {
			return { content: [{ type: "text", text: "No facts stored yet." }], details: { facts: [] } };
		}
		const lines = facts.map((f) => `${f.id}. ${f.text}`);
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
