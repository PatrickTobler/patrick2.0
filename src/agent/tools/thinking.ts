import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { insertThinking, listRecentThinking, listThinkingByTopic, recallThinking } from "../../db/repos/thinking.ts";

const StoreSchema = Type.Object({
	text: Type.String({
		description: "The raw thought from Patrick. First-person preserved. Don't paraphrase or sanitize.",
		minLength: 5,
		maxLength: 5000,
	}),
	topics: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
			description: "1-3 short topic tags (lowercase, hyphenated). E.g. ['demosthenes', 'product-strategy'].",
			maxItems: 5,
		}),
	),
});

export const storeThinkingTool: AgentTool<typeof StoreSchema> = {
	name: "store_thinking",
	label: "Store a thinking dump",
	description:
		"Store a raw thought from Patrick — an evolving opinion, in-progress reasoning, or position that may change. Different from a fact: thinking captures the journey of how Patrick reasons, not a stable truth. Use when Patrick says 'I'm starting to think X', 'my current take on Y is Z', dumps a stream of thought, or shares strategic reasoning. NEVER use for stable preferences/facts (use remember_fact instead).",
	parameters: StoreSchema,
	execute: async (_id, { text, topics }: Static<typeof StoreSchema>) => {
		const row = await insertThinking(text, topics ?? []);
		return {
			content: [
				{ type: "text", text: `Captured thinking #${row.id}${topics?.length ? ` [${topics.join(", ")}]` : ""}.` },
			],
			details: { id: row.id, topics: row.topics },
		};
	},
};

const RecallSchema = Type.Object({
	query: Type.String({
		description: "What to search Patrick's past thinking for. Natural language.",
		minLength: 2,
		maxLength: 500,
	}),
	limit: Type.Optional(Type.Number({ description: "Max results.", minimum: 1, maximum: 20, default: 5 })),
});

export const recallThinkingTool: AgentTool<typeof RecallSchema> = {
	name: "recall_thinking",
	label: "Recall past thinking",
	description:
		"Search Patrick's past thinking dumps semantically. Use when Patrick asks 'what have I been thinking about X?', 'what's my evolving view on Y?', or you need to ground a strategic suggestion in his prior reasoning. Returns thoughts ordered by relevance.",
	parameters: RecallSchema,
	execute: async (_id, { query, limit }: Static<typeof RecallSchema>) => {
		const rows = await recallThinking(query, limit ?? 5);
		if (rows.length === 0) {
			return { content: [{ type: "text", text: "No matching thinking found." }], details: { results: [] } };
		}
		const lines = rows.map((r) => {
			const date = r.created_at.toISOString().slice(0, 10);
			const topics = r.topics?.length ? ` [${r.topics.join(", ")}]` : "";
			return `(${date})${topics}\n${r.text}`;
		});
		return {
			content: [{ type: "text", text: lines.join("\n\n---\n\n") }],
			details: { results: rows.map((r) => ({ id: r.id, similarity: r.similarity, topics: r.topics })) },
		};
	},
};

const ListSchema = Type.Object({
	topic: Type.Optional(
		Type.String({ description: "Filter by exact topic tag (lowercase). Omit for recent across all.", maxLength: 40 }),
	),
	limit: Type.Optional(Type.Number({ description: "Max results.", minimum: 1, maximum: 50, default: 20 })),
});

export const listThinkingTool: AgentTool<typeof ListSchema> = {
	name: "list_thinking",
	label: "List recent thinking",
	description:
		"List recent thinking dumps (newest first), optionally filtered by topic tag. Use when Patrick wants to review what he's been chewing on.",
	parameters: ListSchema,
	execute: async (_id, { topic, limit }: Static<typeof ListSchema>) => {
		const rows = topic ? await listThinkingByTopic(topic, limit ?? 20) : await listRecentThinking(limit ?? 20);
		if (rows.length === 0) {
			return {
				content: [{ type: "text", text: topic ? `No thinking on '${topic}'.` : "No thinking yet." }],
				details: { results: [] },
			};
		}
		const lines = rows.map(
			(r) =>
				`${r.id}. (${r.created_at.toISOString().slice(0, 10)}) ${r.text.slice(0, 120)}${r.text.length > 120 ? "…" : ""}`,
		);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { count: rows.length } };
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const thinkingTools: AgentTool<any>[] = [storeThinkingTool, recallThinkingTool, listThinkingTool];
