import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { appendNote, listNotes, readNote, searchNotes, writeNote } from "../../vault/notes.ts";

const ListSchema = Type.Object({
	prefix: Type.Optional(
		Type.String({ description: "Subdirectory prefix (e.g. 'Tech/', 'Daily/'). Empty = whole vault.", maxLength: 200 }),
	),
	limit: Type.Optional(Type.Number({ description: "Max notes returned.", minimum: 1, maximum: 500, default: 50 })),
});

export const listNotesTool: AgentTool<typeof ListSchema> = {
	name: "list_notes",
	label: "List vault notes",
	description:
		"List notes in Patrick's Obsidian vault, newest-modified first. Use to discover what notes exist or browse by folder. Always returns relative paths usable with read_note/write_note/append_note.",
	parameters: ListSchema,
	execute: async (_id, { prefix, limit }: Static<typeof ListSchema>) => {
		const rows = await listNotes(prefix ?? "", limit ?? 50);
		if (rows.length === 0)
			return {
				content: [{ type: "text", text: `No notes found${prefix ? ` under ${prefix}` : ""}.` }],
				details: { count: 0 },
			};
		const lines = rows.map((r) => `${r.mtime.toISOString().slice(0, 10)} ${r.path}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { count: rows.length } };
	},
};

const ReadSchema = Type.Object({
	path: Type.String({
		description: "Relative path inside the vault, e.g. 'Tech/OpenRouter.md'.",
		minLength: 1,
		maxLength: 500,
	}),
});

export const readNoteTool: AgentTool<typeof ReadSchema> = {
	name: "read_note",
	label: "Read a vault note",
	description:
		"Read the full markdown content of a note in Patrick's Obsidian vault. Use after list_notes or search_notes when Patrick wants details from a specific note.",
	parameters: ReadSchema,
	execute: async (_id, { path }: Static<typeof ReadSchema>) => {
		const body = await readNote(path);
		return { content: [{ type: "text", text: body }], details: { path, bytes: body.length } };
	},
};

const SearchSchema = Type.Object({
	query: Type.String({
		description: "Substring or phrase to search for. Case-insensitive.",
		minLength: 2,
		maxLength: 200,
	}),
	limit: Type.Optional(Type.Number({ description: "Max hits.", minimum: 1, maximum: 50, default: 10 })),
});

export const searchNotesTool: AgentTool<typeof SearchSchema> = {
	name: "search_notes",
	label: "Search vault notes",
	description:
		"Search Patrick's Obsidian vault for a phrase. Returns paths + match snippets ranked by hit count. Use when Patrick asks 'find my notes on X' or you need vault context to answer a question.",
	parameters: SearchSchema,
	execute: async (_id, { query, limit }: Static<typeof SearchSchema>) => {
		const hits = await searchNotes(query, limit ?? 10);
		if (hits.length === 0)
			return { content: [{ type: "text", text: `No matches for "${query}".` }], details: { count: 0 } };
		const lines = hits.map((h) => `**${h.path}** (${h.score} hits)\n  ${h.snippet}`);
		return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: hits.length } };
	},
};

const WriteSchema = Type.Object({
	path: Type.String({
		description: "Relative path, e.g. 'Daily/2026-04-19.md'. Will be created if missing.",
		minLength: 1,
		maxLength: 500,
	}),
	content: Type.String({
		description: "Full markdown body. Replaces any existing content.",
		minLength: 1,
		maxLength: 100_000,
	}),
});

export const writeNoteTool: AgentTool<typeof WriteSchema> = {
	name: "write_note",
	label: "Write a vault note",
	description:
		"Create or overwrite a note in the vault. Use sparingly — prefers append_note for journals/logs. Always overwrites: confirm with Patrick first if the path likely already exists.",
	parameters: WriteSchema,
	execute: async (_id, { path, content }: Static<typeof WriteSchema>) => {
		const rel = await writeNote(path, content);
		return { content: [{ type: "text", text: `Wrote ${rel}.` }], details: { path: rel } };
	},
};

const AppendSchema = Type.Object({
	path: Type.String({ description: "Relative path. Created if missing.", minLength: 1, maxLength: 500 }),
	content: Type.String({
		description: "Markdown to append (a newline is auto-inserted before).",
		minLength: 1,
		maxLength: 50_000,
	}),
});

export const appendNoteTool: AgentTool<typeof AppendSchema> = {
	name: "append_note",
	label: "Append to a vault note",
	description:
		"Append markdown to the end of a note. Use for journals, logs, captured thoughts that grow over time. Safer than write_note (no overwrite).",
	parameters: AppendSchema,
	execute: async (_id, { path, content }: Static<typeof AppendSchema>) => {
		const rel = await appendNote(path, content);
		return { content: [{ type: "text", text: `Appended to ${rel}.` }], details: { path: rel } };
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const vaultTools: AgentTool<any>[] = [
	listNotesTool,
	readNoteTool,
	searchNotesTool,
	writeNoteTool,
	appendNoteTool,
];
