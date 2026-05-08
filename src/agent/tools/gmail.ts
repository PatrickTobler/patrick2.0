import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { listGoogleAccounts } from "../../google/auth.ts";
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
	return `${flag} [${e.account}] ${e.id} | ${e.date.slice(0, 16)} | ${e.from} | ${e.subject}\n  ${e.snippet.slice(0, 120)}`;
}

const ACCOUNT_DESC =
	"Email account key. Defaults to 'all' (lists/searches across every configured Google account); pass a specific account name like 'primary' or 'personal' to scope. For follow-up calls (read_email, label_email, mark_read, mark_unread, draft_email, send_draft), pass the account from the listEmails result so we hit the right inbox.";

const ListSchema = Type.Object({
	q: Type.Optional(
		Type.String({
			description:
				"Gmail search query (same syntax as the web UI: 'is:unread', 'from:alex', 'subject:invoice', 'newer_than:2d', etc.). Default: 'is:unread'.",
			maxLength: 500,
		}),
	),
	max: Type.Optional(
		Type.Number({ description: "Max emails (after merge across accounts).", minimum: 1, maximum: 50, default: 15 }),
	),
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const listEmailsTool: AgentTool<typeof ListSchema> = {
	name: "list_emails",
	label: "List Gmail messages",
	description:
		"List Gmail messages matching a query, merged across all configured accounts by default. Each result is prefixed with [account] so you can pass that to read_email/label_email/etc. Use Gmail search syntax for filters (from:, to:, subject:, has:attachment, newer_than:2d, label:starred, etc.). Returns id + summary — call read_email for full body.",
	parameters: ListSchema,
	execute: async (_id, { q, max, account }: Static<typeof ListSchema>) => {
		const emails = await listMessages({
			q: q ?? "is:unread",
			maxResults: max ?? 15,
			...(account ? { account } : {}),
		});
		if (emails.length === 0) return { content: [{ type: "text", text: "No matching emails." }], details: { count: 0 } };
		return {
			content: [{ type: "text", text: emails.map(fmtSummary).join("\n") }],
			details: {
				count: emails.length,
				items: emails.map((e) => ({ account: e.account, id: e.id, threadId: e.threadId })),
			},
		};
	},
};

const ReadSchema = Type.Object({
	id: Type.String({ description: "Email message id from list_emails.", minLength: 1, maxLength: 200 }),
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const readEmailTool: AgentTool<typeof ReadSchema> = {
	name: "read_email",
	label: "Read an email",
	description:
		"Fetch the full text body of a specific email. Pass `account` from the list_emails result so we hit the right inbox (defaults to 'primary').",
	parameters: ReadSchema,
	execute: async (_id, { id, account }: Static<typeof ReadSchema>) => {
		const email = await readEmail(id, account);
		const text = `From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\nAccount: ${email.account}\nThread: ${email.threadId}\n\n${email.body}`;
		return { content: [{ type: "text", text }], details: { id, threadId: email.threadId, account: email.account } };
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
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const draftReplyTool: AgentTool<typeof DraftSchema> = {
	name: "draft_email",
	label: "Draft an email reply",
	description:
		"Create a draft reply in Gmail. ALWAYS draft first (don't auto-send) and confirm with Patrick before calling send_draft. Pass `account` from the original email so the draft lands in the right inbox.",
	parameters: DraftSchema,
	execute: async (_id, params: Static<typeof DraftSchema>) => {
		const draft = await createDraft({
			threadId: params.thread_id,
			to: params.to,
			subject: params.subject,
			body: params.body,
			...(params.in_reply_to ? { inReplyTo: params.in_reply_to } : {}),
			...(params.account ? { account: params.account } : {}),
		});
		return {
			content: [
				{
					type: "text",
					text: `Drafted (account=${params.account ?? "primary"}, id ${draft.id}):\nTo: ${params.to}\nSubject: ${params.subject}\n\n${params.body}\n\nReply 'send' or call send_draft with id="${draft.id}" account="${params.account ?? "primary"}" to send it.`,
				},
			],
			details: { id: draft.id, messageId: draft.messageId, account: params.account ?? "primary" },
		};
	},
};

const SendSchema = Type.Object({
	id: Type.String({ description: "Draft id from draft_email or draft_new_email.", minLength: 1, maxLength: 200 }),
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const sendDraftTool: AgentTool<typeof SendSchema> = {
	name: "send_draft",
	label: "Send a Gmail draft",
	description:
		"Send a previously-created draft. Pass the same `account` you used to create the draft. ONLY call this after Patrick has explicitly approved by saying 'send', 'send it', 'looks good, send', or similar. NEVER auto-send.",
	parameters: SendSchema,
	execute: async (_id, { id, account }: Static<typeof SendSchema>) => {
		const sent = await sendDraft(id, account);
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
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const draftNewEmailTool: AgentTool<typeof NewDraftSchema> = {
	name: "draft_new_email",
	label: "Draft a new (non-reply) email",
	description:
		"Create a fresh outbound email draft (NOT a reply — for replies use draft_email with thread_id). Pass `account` to choose which inbox sends from. Always draft first, wait for explicit Patrick approval, then call send_draft. NEVER auto-send.",
	parameters: NewDraftSchema,
	execute: async (_id, params: Static<typeof NewDraftSchema>) => {
		const draft = await createNewDraft(params);
		return {
			content: [
				{
					type: "text",
					text: `Drafted (account=${params.account ?? "primary"}, id ${draft.id}):\nTo: ${params.to}\nSubject: ${params.subject}\n\n${params.body}\n\nReply 'send' or call send_draft with id="${draft.id}" account="${params.account ?? "primary"}" to send it.`,
				},
			],
			details: { id: draft.id, messageId: draft.messageId, account: params.account ?? "primary" },
		};
	},
};

const MarkSchema = Type.Object({
	id: Type.String({
		description: "Email message id (from list_emails or read_email).",
		minLength: 1,
		maxLength: 200,
	}),
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

export const markReadTool: AgentTool<typeof MarkSchema> = {
	name: "mark_read",
	label: "Mark email as read",
	description:
		"Mark an email as read (removes the UNREAD label). Pass `account` from list_emails so we modify the right inbox. Don't mark important/actionable emails as read without telling Patrick.",
	parameters: MarkSchema,
	execute: async (_id, { id, account }: Static<typeof MarkSchema>) => {
		await modifyLabels({ messageId: id, removeLabelIds: ["UNREAD"], ...(account ? { account } : {}) });
		return {
			content: [{ type: "text", text: `Marked ${id} (account=${account ?? "primary"}) as read.` }],
			details: { id, account: account ?? "primary" },
		};
	},
};

export const markUnreadTool: AgentTool<typeof MarkSchema> = {
	name: "mark_unread",
	label: "Mark email as unread",
	description:
		"Mark an email as unread (adds the UNREAD label). Pass `account` from list_emails. Useful for 'remind me later' patterns or to undo a mistaken mark_read.",
	parameters: MarkSchema,
	execute: async (_id, { id, account }: Static<typeof MarkSchema>) => {
		await modifyLabels({ messageId: id, addLabelIds: ["UNREAD"], ...(account ? { account } : {}) });
		return {
			content: [{ type: "text", text: `Marked ${id} (account=${account ?? "primary"}) as unread.` }],
			details: { id, account: account ?? "primary" },
		};
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
	account: Type.Optional(Type.String({ description: ACCOUNT_DESC, maxLength: 50 })),
});

const FORBIDDEN_ADD = new Set(["spam", "trash"]);
const FORBIDDEN_REMOVE = new Set(["inbox"]); // removing INBOX is archive — Patrick said no archive.

export const labelEmailTool: AgentTool<typeof LabelSchema> = {
	name: "label_email",
	label: "Add or remove Gmail labels",
	description:
		"Add and/or remove Gmail labels on a message by NAME (case-insensitive). Pass `account` from list_emails so we modify the right inbox. RESTRICTED: cannot add SPAM/TRASH; cannot remove INBOX (= archive). For mark-as-read use mark_read; for star/unstar use add=['STARRED']/remove=['STARRED']. Unknown label names refuse without changes.",
	parameters: LabelSchema,
	execute: async (_id, { id, add, remove, account }: Static<typeof LabelSchema>) => {
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

		const addRes = await resolveLabelIds(addNames, account);
		const removeRes = await resolveLabelIds(removeNames, account);
		const unknown = [...addRes.unknown, ...removeRes.unknown];
		if (unknown.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Refused: unknown label name(s) ${unknown.join(", ")} in account=${account ?? "primary"}. Use exact label names as they appear in that Gmail account. System labels: STARRED, IMPORTANT, UNREAD.`,
					},
				],
				details: { error: "unknown_labels", unknown, account: account ?? "primary" },
			};
		}

		await modifyLabels({
			messageId: id,
			addLabelIds: addRes.resolved,
			removeLabelIds: removeRes.resolved,
			...(account ? { account } : {}),
		});
		const summary =
			(addNames.length ? `+${addNames.join(",")}` : "") + (removeNames.length ? ` -${removeNames.join(",")}` : "");
		return {
			content: [{ type: "text", text: `Updated labels on ${id} (account=${account ?? "primary"}): ${summary.trim()}` }],
			details: { id, added: addNames, removed: removeNames, account: account ?? "primary" },
		};
	},
};

const AccountListSchema = Type.Object({});

export const listAccountsTool: AgentTool<typeof AccountListSchema> = {
	name: "list_email_accounts",
	label: "List configured Gmail accounts",
	description:
		"List the Google account keys configured on the server (e.g. 'primary', 'personal'). Useful when Patrick says 'check my personal inbox' so you know which account name to pass.",
	parameters: AccountListSchema,
	execute: async () => {
		const accounts = listGoogleAccounts();
		const text =
			accounts.length === 0 ? "No Google accounts configured." : `Configured accounts: ${accounts.join(", ")}`;
		return { content: [{ type: "text", text }], details: { accounts } };
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const gmailTools: AgentTool<any>[] = [
	listAccountsTool,
	listEmailsTool,
	readEmailTool,
	draftReplyTool,
	draftNewEmailTool,
	sendDraftTool,
	markReadTool,
	markUnreadTool,
	labelEmailTool,
];
