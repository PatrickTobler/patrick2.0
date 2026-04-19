import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { type CalendarEvent, createEvent, deleteEvent, listEvents } from "../../google/calendar.ts";

const PATRICK_TZ = "Europe/Zurich";

function fmtEvent(e: CalendarEvent): string {
	const start = e.start.replace("T", " ").replace(/(\+\d{2}:\d{2}|Z)$/, "");
	const end = e.end.replace("T", " ").replace(/(\+\d{2}:\d{2}|Z)$/, "");
	const who = e.attendees.length ? ` w/ ${e.attendees.map((a) => a.email).join(", ")}` : "";
	const loc = e.location ? ` @ ${e.location}` : "";
	return `${start} → ${end}: ${e.summary}${who}${loc}`;
}

const ListSchema = Type.Object({
	from_iso: Type.Optional(Type.String({ description: "ISO 8601 start of window. Default: now.", maxLength: 40 })),
	to_iso: Type.Optional(
		Type.String({ description: "ISO 8601 end of window. Default: 24h from from_iso.", maxLength: 40 }),
	),
	max: Type.Optional(Type.Number({ description: "Max events.", minimum: 1, maximum: 50, default: 25 })),
});

export const listEventsTool: AgentTool<typeof ListSchema> = {
	name: "list_events",
	label: "List calendar events",
	description:
		"List Patrick's primary Google Calendar events in a time window. Use for 'what's on my schedule today/this week'. Defaults to next 24h. Use current_time to get 'now' if needed for relative windows.",
	parameters: ListSchema,
	execute: async (_id, params: Static<typeof ListSchema>) => {
		const now = new Date();
		const fromIso = params.from_iso ?? now.toISOString();
		const toIso = params.to_iso ?? new Date(new Date(fromIso).getTime() + 24 * 3600 * 1000).toISOString();
		const events = await listEvents({ timeMin: fromIso, timeMax: toIso, maxResults: params.max ?? 25 });
		if (events.length === 0)
			return { content: [{ type: "text", text: "No events in window." }], details: { count: 0 } };
		return {
			content: [{ type: "text", text: events.map(fmtEvent).join("\n") }],
			details: { count: events.length, ids: events.map((e) => e.id) },
		};
	},
};

const CreateSchema = Type.Object({
	summary: Type.String({ description: "Event title.", minLength: 1, maxLength: 200 }),
	start_iso: Type.String({
		description: "Start time, ISO 8601 with timezone (e.g. '2026-04-20T14:00:00+02:00').",
		maxLength: 40,
	}),
	end_iso: Type.String({ description: "End time, ISO 8601 with timezone.", maxLength: 40 }),
	description: Type.Optional(Type.String({ description: "Event details / agenda.", maxLength: 5000 })),
	location: Type.Optional(
		Type.String({ description: "Place or link (e.g. 'https://meet.google.com/...').", maxLength: 500 }),
	),
	attendees: Type.Optional(
		Type.Array(Type.String({ description: "Attendee email." }), { description: "Emails to invite.", maxItems: 30 }),
	),
});

export const createEventTool: AgentTool<typeof CreateSchema> = {
	name: "create_event",
	label: "Create calendar event",
	description:
		"Create an event on Patrick's primary Google Calendar. Sends invites to attendees. ALWAYS pass start_iso and end_iso with timezone offset. Use current_time first to resolve relative phrases ('tomorrow afternoon' → absolute ISO in Patrick's tz).",
	parameters: CreateSchema,
	execute: async (_id, params: Static<typeof CreateSchema>) => {
		const event = await createEvent({
			summary: params.summary,
			startIso: params.start_iso,
			endIso: params.end_iso,
			...(params.description ? { description: params.description } : {}),
			...(params.location ? { location: params.location } : {}),
			...(params.attendees ? { attendees: params.attendees } : {}),
			timeZone: PATRICK_TZ,
		});
		return {
			content: [{ type: "text", text: `Created: ${fmtEvent(event)}\n${event.htmlLink ?? ""}` }],
			details: { id: event.id, htmlLink: event.htmlLink },
		};
	},
};

const DeleteSchema = Type.Object({
	id: Type.String({ description: "Event id from list_events.", minLength: 1, maxLength: 200 }),
});

export const deleteEventTool: AgentTool<typeof DeleteSchema> = {
	name: "delete_event",
	label: "Delete calendar event",
	description: "Cancel an event by id. Sends cancellation to attendees. Use list_events first to find the id.",
	parameters: DeleteSchema,
	execute: async (_id, { id }: Static<typeof DeleteSchema>) => {
		await deleteEvent(id);
		return { content: [{ type: "text", text: `Deleted event ${id}.` }], details: { id } };
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const calendarTools: AgentTool<any>[] = [listEventsTool, createEventTool, deleteEventTool];
