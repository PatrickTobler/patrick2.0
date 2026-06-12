import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { query } from "../../db/pool.ts";
import { insertMessage } from "../../db/repos/messages.ts";
import {
	enqueueNotification,
	findNotifiedByKey,
	findSimilarNotification,
	insertNotifiedItem,
} from "../../db/repos/notifications.ts";
import { embed } from "../../llm/embeddings.ts";
import { log } from "../../log.ts";
import { sendTelegramToOwner } from "../../telegram/sender.ts";

// Dedup and quiet hours are enforced HERE, deterministically. The model's only jobs
// are picking a stable item_key and classifying urgency — schema-level decisions a
// cheap model can make reliably, unlike "remember everything you ever sent".
const DEDUP_WINDOW_DAYS = 14;
const NEAR_DUP_SIMILARITY = 0.9;
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

const TIMEZONE_KV_KEY = "current_timezone";
const DEFAULT_TIMEZONE = "Europe/Zurich";

export async function getCurrentTimezone(): Promise<string> {
	try {
		const res = await query<{ value: string }>("select value #>> '{}' as value from kv where key = $1", [
			TIMEZONE_KV_KEY,
		]);
		return res.rows[0]?.value || DEFAULT_TIMEZONE;
	} catch {
		return DEFAULT_TIMEZONE;
	}
}

function localHourMinute(tz: string): { hour: number; minute: number } {
	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date());
		const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
		const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
		return { hour, minute };
	} catch {
		return { hour: 12, minute: 0 }; // unknown tz → assume daytime, fail open
	}
}

function inQuietHours(hour: number): boolean {
	return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** Instant of the next 07:00 in the given timezone. */
function nextMorning(tz: string): Date {
	const { hour, minute } = localHourMinute(tz);
	const minutesNow = hour * 60 + minute;
	const minutesUntil = (QUIET_END_HOUR * 60 - minutesNow + 24 * 60) % (24 * 60);
	return new Date(Date.now() + minutesUntil * 60_000);
}

async function persistToHistory(text: string): Promise<void> {
	try {
		const cfg = getConfig();
		const rawMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "openai",
			model: "scheduled-push",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		await insertMessage({ chatId: cfg.telegramOwnerChatId, role: "assistant", content: text, rawMessage });
	} catch (err) {
		log.warn({ err }, "failed to persist notification to history");
	}
}

const NotifySchema = Type.Object({
	item_key: Type.String({
		description:
			"Stable id of the THING you're notifying about — Gmail message id, masumi thread id, or '<sender>|<subject>' if no id exists. Same thing = same key, always. The tool refuses duplicates, so a good key is what protects Patrick from being pinged twice.",
		minLength: 3,
		maxLength: 300,
	}),
	urgency: Type.Union([Type.Literal("urgent"), Type.Literal("normal")], {
		description:
			"urgent = security, money at risk, blocking Patrick today/tomorrow morning, explicit deadline within 24h. Everything else is normal. During quiet hours (23:00-07:00 Patrick's local time) only urgent is delivered immediately; normal is queued for the 07:00 batch.",
	}),
	text: Type.String({
		description: "The notification text. Plain text, terse, lead with the point.",
		minLength: 1,
		maxLength: 4000,
	}),
});

export const notifyPatrickTool: AgentTool<typeof NotifySchema> = {
	name: "notify_patrick",
	label: "Notify Patrick",
	description:
		"Notify Patrick about a specific item/event (new email, thread, alert, lead). ALWAYS prefer this over send_telegram_message when the notification is about an identifiable thing: it deduplicates against everything already sent (so you cannot accidentally re-ping) and handles quiet hours automatically. Use send_telegram_message only for explicit-send tasks like briefs, reports and reminders.",
	parameters: NotifySchema,
	execute: async (_id, { item_key, urgency, text }: Static<typeof NotifySchema>) => {
		// 1. Exact-key dedup.
		const prior = await findNotifiedByKey(item_key, DEDUP_WINDOW_DAYS);
		if (prior) {
			const when = prior.created_at.toISOString().slice(0, 16).replace("T", " ");
			const snippet = prior.text.length > 160 ? `${prior.text.slice(0, 160)}…` : prior.text;
			return {
				content: [
					{
						type: "text",
						text: `DUPLICATE — Patrick was already notified about "${item_key}" on ${when}: "${snippet}". NOT sent. Do not retry with a tweaked text. Only if something genuinely NEW happened, call again with item_key "${item_key}#update-${new Date().toISOString().slice(0, 10)}" and text covering ONLY the new part.`,
					},
				],
				details: { sent: false, reason: "duplicate-key", priorDate: prior.created_at },
			};
		}

		// 2. Near-duplicate dedup (catches same news under a different key).
		const vec = await embed(text);
		if (vec) {
			const similar = await findSimilarNotification(vec, DEDUP_WINDOW_DAYS, NEAR_DUP_SIMILARITY);
			if (similar) {
				const when = similar.created_at.toISOString().slice(0, 16).replace("T", " ");
				const snippet = similar.text.length > 160 ? `${similar.text.slice(0, 160)}…` : similar.text;
				return {
					content: [
						{
							type: "text",
							text: `NEAR-DUPLICATE (${Math.round(similar.similarity * 100)}% similar) — Patrick already got this on ${when}: "${snippet}". NOT sent. Stay silent on this item.`,
						},
					],
					details: { sent: false, reason: "near-duplicate", similarity: similar.similarity },
				};
			}
		}

		// Record BEFORE delivery — a queued item must dedup future runs too.
		await insertNotifiedItem({ itemKey: item_key, urgency, text, embedding: vec });

		// 3. Quiet hours: normal-urgency waits for the 07:00 batch.
		const tz = await getCurrentTimezone();
		const { hour, minute } = localHourMinute(tz);
		if (urgency === "normal" && inQuietHours(hour)) {
			const deliverAfter = nextMorning(tz);
			await enqueueNotification(text, urgency, deliverAfter);
			return {
				content: [
					{
						type: "text",
						text: `QUEUED — it is ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} for Patrick (${tz}), quiet hours. Will be delivered in the 07:00 batch. Treat as sent; do NOT resend.`,
					},
				],
				details: { sent: false, queued: true, deliverAfter },
			};
		}

		const sent = await sendTelegramToOwner(text);
		await persistToHistory(text);
		return {
			content: [{ type: "text", text: `Sent (msg id ${sent.messageId}), recorded under "${item_key}".` }],
			details: { sent: true, messageId: sent.messageId },
		};
	},
};

const TimezoneSchema = Type.Object({
	timezone: Type.String({
		description: "IANA timezone Patrick is currently in, e.g. 'Asia/Ho_Chi_Minh', 'Europe/Zurich'.",
		minLength: 3,
		maxLength: 50,
	}),
});

export const setCurrentTimezoneTool: AgentTool<typeof TimezoneSchema> = {
	name: "set_current_timezone",
	label: "Set Patrick's current timezone",
	description:
		"Record the timezone Patrick is CURRENTLY in (drives quiet hours for notifications). Call when Patrick mentions traveling or a flight confirmation makes his location obvious. Set it back when he returns home (Europe/Zurich).",
	parameters: TimezoneSchema,
	execute: async (_id, { timezone }: Static<typeof TimezoneSchema>) => {
		// Validate by attempting to format with it.
		try {
			new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
		} catch {
			throw new Error(`Invalid IANA timezone: "${timezone}"`);
		}
		await query(
			`insert into kv (key, value, updated_at) values ($1, to_jsonb($2::text), now())
			 on conflict (key) do update set value = to_jsonb($2::text), updated_at = now()`,
			[TIMEZONE_KV_KEY, timezone],
		);
		const { hour, minute } = localHourMinute(timezone);
		return {
			content: [
				{
					type: "text",
					text: `Timezone set to ${timezone} (local time now ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}).`,
				},
			],
			details: { timezone },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const notifyTools: AgentTool<any>[] = [notifyPatrickTool, setCurrentTimezoneTool];
