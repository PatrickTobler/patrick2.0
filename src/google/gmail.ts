import { getGoogleAccessToken } from "./auth.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface EmailSummary {
	id: string;
	threadId: string;
	from: string;
	to: string;
	subject: string;
	snippet: string;
	date: string;
	unread: boolean;
}

interface RawHeader {
	name: string;
	value: string;
}

interface RawMessage {
	id: string;
	threadId: string;
	snippet?: string;
	internalDate?: string;
	labelIds?: string[];
	payload?: {
		headers?: RawHeader[];
		body?: { data?: string };
		parts?: { mimeType: string; body?: { data?: string }; parts?: unknown[] }[];
		mimeType?: string;
	};
}

function header(headers: RawHeader[] | undefined, name: string): string {
	if (!headers) return "";
	const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
	return h?.value ?? "";
}

// Retry config for transient errors (429 rate limit, 5xx server errors).
// Triage runs against 30 unread messages do 30+ getMessage calls in quick
// succession; Gmail's per-user-per-second quota can briefly trip 429. We
// back off and retry instead of bubbling to the agent as a hard failure.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function callApi<T>(path: string, init: RequestInit = {}): Promise<T> {
	let lastBody = "";
	let lastStatus = 0;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const token = await getGoogleAccessToken();
		const res = await fetch(`${BASE}${path}`, {
			...init,
			headers: {
				...(init.headers as Record<string, string> | undefined),
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});
		if (res.ok) return (await res.json()) as T;

		lastStatus = res.status;
		lastBody = await res.text();
		if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) break;

		// Honor Retry-After if Gmail sent one; otherwise exponential backoff with jitter
		const retryAfterRaw = res.headers.get("retry-after");
		const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : NaN;
		const backoff = Number.isFinite(retryAfterMs) ? retryAfterMs : BASE_DELAY_MS * 2 ** attempt;
		const jitter = Math.floor(Math.random() * 200);
		await sleep(backoff + jitter);
	}
	throw new Error(`Gmail API ${lastStatus} on ${path}: ${lastBody.slice(0, 300)}`);
}

// Cap on parallel getMessage calls per listMessages. Gmail's per-user
// burst limit is generous but not infinite — fanning out 30 requests at
// once routinely trips 429. 8 parallel keeps total wall time low while
// staying well under the burst cap.
const LIST_CONCURRENCY = 8;

async function mapWithConcurrency<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
	const results: O[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			const item = items[idx];
			if (item === undefined) continue;
			results[idx] = await fn(item);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function listMessages(opts: { q?: string; maxResults?: number }): Promise<EmailSummary[]> {
	const params = new URLSearchParams({ maxResults: String(opts.maxResults ?? 20) });
	if (opts.q) params.set("q", opts.q);
	const list = await callApi<{ messages?: { id: string; threadId: string }[] }>(`/messages?${params}`);
	const ids = (list.messages ?? []).slice(0, opts.maxResults ?? 20);
	const summaries = await mapWithConcurrency(ids, LIST_CONCURRENCY, (m) => getMessage(m.id, "metadata"));
	return summaries.map(toSummary);
}

export async function getMessage(id: string, format: "metadata" | "full" = "metadata"): Promise<RawMessage> {
	const params = new URLSearchParams({ format });
	if (format === "metadata") {
		params.append("metadataHeaders", "From");
		params.append("metadataHeaders", "To");
		params.append("metadataHeaders", "Subject");
		params.append("metadataHeaders", "Date");
	}
	return callApi<RawMessage>(`/messages/${id}?${params}`);
}

function toSummary(m: RawMessage): EmailSummary {
	return {
		id: m.id,
		threadId: m.threadId,
		from: header(m.payload?.headers, "From"),
		to: header(m.payload?.headers, "To"),
		subject: header(m.payload?.headers, "Subject"),
		snippet: m.snippet ?? "",
		date: header(m.payload?.headers, "Date") || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ""),
		unread: (m.labelIds ?? []).includes("UNREAD"),
	};
}

function decodeBase64Url(data: string): string {
	const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(b64, "base64").toString("utf-8");
}

function extractBody(payload: RawMessage["payload"]): string {
	if (!payload) return "";
	const visit = (part: NonNullable<RawMessage["payload"]>): string | null => {
		if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
		for (const sub of part.parts ?? []) {
			const r = visit(sub as NonNullable<RawMessage["payload"]>);
			if (r) return r;
		}
		if (part.mimeType === "text/html" && part.body?.data) {
			return decodeBase64Url(part.body.data)
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		}
		if (part.body?.data) return decodeBase64Url(part.body.data);
		return null;
	};
	return visit(payload) ?? "";
}

export async function readEmail(id: string): Promise<EmailSummary & { body: string }> {
	const full = await getMessage(id, "full");
	return { ...toSummary(full), body: extractBody(full.payload) };
}

export interface DraftReplyInput {
	threadId: string;
	to: string;
	subject: string;
	body: string;
	inReplyTo?: string;
}

function buildRfc822(input: { to: string; subject: string; body: string; inReplyTo?: string; from?: string }): string {
	const headers: string[] = [
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
	];
	if (input.from) headers.unshift(`From: ${input.from}`);
	if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
	return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

function encodeBase64Url(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createDraft(input: DraftReplyInput): Promise<{ id: string; messageId: string }> {
	const raw = encodeBase64Url(buildRfc822(input));
	const data = await callApi<{ id: string; message: { id: string } }>("/drafts", {
		method: "POST",
		body: JSON.stringify({ message: { raw, threadId: input.threadId } }),
	});
	return { id: data.id, messageId: data.message.id };
}

export async function sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
	return callApi("/drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
}

export async function sendNew(input: { to: string; subject: string; body: string }): Promise<{
	id: string;
	threadId: string;
}> {
	const raw = encodeBase64Url(buildRfc822(input));
	return callApi("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
}

export interface CreateNewDraftInput {
	to: string;
	subject: string;
	body: string;
}

export async function createNewDraft(input: CreateNewDraftInput): Promise<{ id: string; messageId: string }> {
	const raw = encodeBase64Url(buildRfc822(input));
	const data = await callApi<{ id: string; message: { id: string } }>("/drafts", {
		method: "POST",
		body: JSON.stringify({ message: { raw } }),
	});
	return { id: data.id, messageId: data.message.id };
}

export interface GmailLabel {
	id: string;
	name: string;
	type: "system" | "user";
}

let labelCache: GmailLabel[] | null = null;

export async function listLabels(): Promise<GmailLabel[]> {
	if (labelCache) return labelCache;
	const data = await callApi<{ labels?: GmailLabel[] }>("/labels");
	labelCache = data.labels ?? [];
	return labelCache;
}

// Resolve label NAMES to label IDs (case-insensitive). System labels (INBOX,
// UNREAD, STARRED, IMPORTANT, etc.) and user labels alike. Unknown names are
// returned in `unknown` so the caller can refuse the operation.
export async function resolveLabelIds(names: string[]): Promise<{ resolved: string[]; unknown: string[] }> {
	if (names.length === 0) return { resolved: [], unknown: [] };
	const labels = await listLabels();
	const byNameLower = new Map<string, string>();
	for (const l of labels) byNameLower.set(l.name.toLowerCase(), l.id);
	const resolved: string[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const id = byNameLower.get(name.toLowerCase());
		if (id) resolved.push(id);
		else unknown.push(name);
	}
	return { resolved, unknown };
}

export interface ModifyLabelsInput {
	messageId: string;
	addLabelIds?: string[];
	removeLabelIds?: string[];
}

export async function modifyLabels(input: ModifyLabelsInput): Promise<void> {
	await callApi(`/messages/${input.messageId}/modify`, {
		method: "POST",
		body: JSON.stringify({
			addLabelIds: input.addLabelIds ?? [],
			removeLabelIds: input.removeLabelIds ?? [],
		}),
	});
}
