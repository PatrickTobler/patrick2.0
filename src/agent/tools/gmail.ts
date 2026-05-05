import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type EmailSummary,
	createDraft,
	createNewDraft,
	listMessages,
	modifyLabels,
	readEmail,
	resolveLabelIds,
	sendDraft,
} from "../../google/gmail.ts";

function fmtSummary(e: EmailSummary): string {
	const flag = e.unread ? "•" : " ";
	return `${flag} ${e.id} | ${e.date.slice(0, 16)} | ${e.from} | ${e.subject}\n  ${e.snippet.slice(0, 120)}`;
}

const ListSchema = Type.Object({
	q: Type.Optional(
		Type.String({
			description:
				"Gmail search query (same syntax as the web UI: 'is:unread', 'from:alex', 'subject:invoice', 'newer_than:2d', etc.). Default: 'is:unread'.",
			maxLength: 500,
		}),
	),
	max: Type.Optional(Type.Number({ description: "Max emails.", minimum: 1, maximum: 50, default: 15 })),
});

export const listEmailsTool: AgentTool<typeof ListSchema> = {
	name: "list_emails",
	label: "List Gmail messages",
	description:
		"List Patrick's Gmail messages matching a query. Default returns unread. Use Gmail search syntax for filters (from:, to:, subject:, has:attachment, newer_than:2d, label:starred, etc.). Returns id + summary — call read_email for full body.",
	parameters: ListSchema,
	execute: async (_id, { q, max }: Static<typeof ListSchema>) => {
		const emails = await listMessages({ q: q ?? "is:unread", maxResults: max ?? 15 });
		if (emails.length === 0) return { content: [{ type: "text", text: "No matching emails." }], details: { count: 0 } };
		return {
			content: [{ type: "text", text: emails.map(fmtSummary).join("\n") }],
			details: { count: emails.length, ids: emails.map((e) => e.id) },
		};
	},
};

const ReadSchema = Type.Object({
	id: Type.String({ description: "Email message id from list_emails.", minLength: 1, maxLength: 200 }),
});

export const readEmailTool: AgentTool<typeof ReadSchema> = {
	name: "read_email",
	label: "Read an email",
	description:
		"Fetch the full text body of a specific email. Use after list_emails when Patrick wants details on a specific message.",
	parameters: ReadSchema,
	execute: async (_id, { id }: Static<typeof ReadSchema>) => {
		const email = await readEmail(id);
		const text = `From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\nThread: ${email.threadId}\n\n${email.body}`;
		return { content: [{ type: "text", text }], details: { id, threadId: email.threadId } };
	},
};

const DraftSchema = Type.Object({
	thread_id: Type.String({
		description: "Thread id from list_emails or read_email (replies stay in-thread).",
		minLength: 1,
		maxLength: 200,
	}),
	to: Type.String({ description: "Recipient email.", minLength: 3, maxLength: 200 }),
	subject: Type.String({
		description: "Subject (use the original 'Re: …' for replies).",
		minLength: 1,
		maxLength: 300,
	}),
	body: Type.String({
		description: "Plain text body. Match Patrick's tone (terse, direct).",
		minLength: 1,
		maxLength: 50_000,
	}),
	in_reply_to: Type.Optional(
		Type.String({ description: "Original Message-ID header (for proper threading).", maxLength: 300 }),
	),
});

export const draftReplyTool: AgentTool<typeof DraftSchema> = {
	name: "draft_email",
	label: "Draft an email reply",
	description:
		"Create a draft reply in Gmail. ALWAYS draft first (don't auto-send) and confirm with Patrick before calling send_draft. The draft appears in his Gmail Drafts folder so he can also edit it from his inbox.",
	parameters: DraftSchema,
	execute: async (_id, params: Static<typeof DraftSchema>) => {
		const draft = await createDraft({
			threadId: params.thread_id,
			to: params.to,
			subject: params.subject,
			body: params.body,
			...(params.in_reply_to ? { inReplyTo: params.in_reply_to } : {}),
		});
		return {
			content: [
				{
					type: "text",
					text: `Drafted (id ${draft.id}):\nTo: ${params.to}\nSubject: ${params.subject}\n\n${params.body}\n\nReply 'send' or call send_draft with id="${draft.id}" to send it.`,
				},
			],
			details: { id: draft.id, messageId: draft.messageId },
		};
	},
};

const SendSchema = Type.Object({
	id: Type.String({ description: "Draft id from draft_email.", minLength: 1, maxLength: 200 }),
});

export const sendDraftTool: AgentTool<typeof SendSchema> = {
	name: "send_draft",
	label: "Send a Gmail draft",
	description:
		"Send a previously-created draft. ONLY call this after Patrick has explicitly approved by saying 'send', 'send it', 'looks good, send', or similar. NEVER auto-send.",
	parameters: SendSchema,
	execute: async (_id, { id }: Static<typeof SendSchema>) => {
		const sent = await sendDraft(id);
		return { content: [{ type: "text", text: `Sent. message=${sent.id} thread=${sent.threadId}` }], details: sent };
	},
};

const NewDraftSchema = Type.Object({
	to: Type.String({ description: "Recipient email.", minLength: 3, maxLength: 200 }),
	subject: Type.String({ description: "Subject line.", minLength: 1, maxLength: 300 }),
	body: Type.String({
		description: "Plain text body. Match Patrick's tone (terse, direct).",
		minLength: 1,
		maxLength: 50_000,
	}),
});

export const draftNewEmailTool: AgentTool<typeof NewDraftSchema> = {
	name: "draft_new_email",
	label: "Draft a new (non-reply) email",
	description:
		"Create a fresh outbound email draft (NOT a reply — for replies use draft_email with thread_id). Always draft first, wait for explicit Patrick approval, then call send_draft. NEVER auto-send.",
	parameters: NewDraftSchema,
	execute: async (_id, params: Static<typeof NewDraftSchema>) => {
		const draft = await createNewDraft(params);
		return {
			content: [
				{
					type: "text",
					text: `Drafted (id ${draft.id}):\nTo: ${params.to}\nSubject: ${params.subject}\n\n${params.body}\n\nReply 'send' or call send_draft with id="${draft.id}" to send it.`,
				},
			],
			details: { id: draft.id, messageId: draft.messageId },
		};
	},
};

const MarkSchema = Type.Object({
	id: Type.String({
		description: "Email message id (from list_emails or read_email).",
		minLength: 1,
		maxLength: 200,
	}),
});

export const markReadTool: AgentTool<typeof MarkSchema> = {
	name: "mark_read",
	label: "Mark email as read",
	description:
		"Mark an email as read (removes the UNREAD label). Useful after summarizing low-priority emails Patrick doesn't need to see again. Don't mark important/actionable emails as read without telling Patrick.",
	parameters: MarkSchema,
	execute: async (_id, { id }: Static<typeof MarkSchema>) => {
		await modifyLabels({ messageId: id, removeLabelIds: ["UNREAD"] });
		return { content: [{ type: "text", text: `Marked ${id} as read.` }], details: { id } };
	},
};

export const markUnreadTool: AgentTool<typeof MarkSchema> = {
	name: "mark_unread",
	label: "Mark email as unread",
	description:
		"Mark an email as unread (adds the UNREAD label). Useful for 'remind me to look at this later' patterns or to undo an accidental mark_read.",
	parameters: MarkSchema,
	execute: async (_id, { id }: Static<typeof MarkSchema>) => {
		await modifyLabels({ messageId: id, addLabelIds: ["UNREAD"] });
		return { content: [{ type: "text", text: `Marked ${id} as unread.` }], details: { id } };
	},
};

const LabelSchema = Type.Object({
	id: Type.String({ description: "Email message id.", minLength: 1, maxLength: 200 }),
	add: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
			description:
				"Label NAMES to add (case-insensitive). System labels: STARRED, IMPORTANT, UNREAD. Or user-created label names exactly as they appear in Gmail.",
			maxItems: 10,
		}),
	),
	remove: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
			description: "Label NAMES to remove. Same naming as 'add'.",
			maxItems: 10,
		}),
	),
});

const FORBIDDEN_ADD = new Set(["spam", "trash"]);
const FORBIDDEN_REMOVE = new Set(["inbox"]); // removing INBOX is archive — Patrick said no archive.

export const labelEmailTool: AgentTool<typeof LabelSchema> = {
	name: "label_email",
	label: "Add or remove Gmail labels",
	description:
		"Add and/or remove Gmail labels on a message by NAME. Names are case-insensitive. RESTRICTED: cannot add SPAM or TRASH (no auto-spamming or trashing); cannot remove INBOX (that would archive — use Gmail directly if archiving is wanted). For mark-as-read use mark_read; for star/unstar use add=['STARRED'] / remove=['STARRED']. Unknown label names cause the call to refuse without changes.",
	parameters: LabelSchema,
	execute: async (_id, { id, add, remove }: Static<typeof LabelSchema>) => {
		const addNames = (add ?? []).filter(Boolean);
		const removeNames = (remove ?? []).filter(Boolean);

		const blockedAdd = addNames.filter((n) => FORBIDDEN_ADD.has(n.toLowerCase()));
		if (blockedAdd.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Refused: cannot add label(s) ${blockedAdd.join(", ")}. SPAM / TRASH are not exposed.`,
					},
				],
				details: { error: "blocked_add", blocked: blockedAdd },
			};
		}
		const blockedRemove = removeNames.filter((n) => FORBIDDEN_REMOVE.has(n.toLowerCase()));
		if (blockedRemove.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: "Refused: cannot remove INBOX label (would archive — Patrick disabled archiving via this tool).",
					},
				],
				details: { error: "blocked_remove", blocked: blockedRemove },
			};
		}

		const addRes = await resolveLabelIds(addNames);
		const removeRes = await resolveLabelIds(removeNames);
		const unknown = [...addRes.unknown, ...removeRes.unknown];
		if (unknown.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Refused: unknown label name(s) ${unknown.join(", ")}. Use exact label names as they appear in Gmail. System labels: STARRED, IMPORTANT, UNREAD.`,
					},
				],
				details: { error: "unknown_labels", unknown },
			};
		}

		await modifyLabels({ messageId: id, addLabelIds: addRes.resolved, removeLabelIds: removeRes.resolved });
		const summary =
			(addNames.length ? `+${addNames.join(",")}` : "") + (removeNames.length ? ` -${removeNames.join(",")}` : "");
		return {
			content: [{ type: "text", text: `Updated labels on ${id}: ${summary.trim()}` }],
			details: { id, added: addNames, removed: removeNames },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const gmailTools: AgentTool<any>[] = [
	listEmailsTool,
	readEmailTool,
	draftReplyTool,
	draftNewEmailTool,
	sendDraftTool,
	markReadTool,
	markUnreadTool,
	labelEmailTool,
];
