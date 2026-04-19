import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { type EmailSummary, createDraft, listMessages, readEmail, sendDraft } from "../../google/gmail.ts";

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

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const gmailTools: AgentTool<any>[] = [listEmailsTool, readEmailTool, draftReplyTool, sendDraftTool];
