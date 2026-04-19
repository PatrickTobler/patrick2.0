import { getGoogleAccessToken } from "./auth.ts";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarEvent {
	id: string;
	summary: string;
	description?: string;
	location?: string;
	start: string;
	end: string;
	attendees: { email: string; displayName?: string; responseStatus?: string }[];
	htmlLink?: string;
	hangoutLink?: string;
}

interface RawEvent {
	id: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	attendees?: { email: string; displayName?: string; responseStatus?: string }[];
	htmlLink?: string;
	hangoutLink?: string;
}

function toEvent(r: RawEvent): CalendarEvent {
	return {
		id: r.id,
		summary: r.summary ?? "(no title)",
		...(r.description ? { description: r.description } : {}),
		...(r.location ? { location: r.location } : {}),
		start: r.start?.dateTime ?? r.start?.date ?? "",
		end: r.end?.dateTime ?? r.end?.date ?? "",
		attendees: r.attendees ?? [],
		...(r.htmlLink ? { htmlLink: r.htmlLink } : {}),
		...(r.hangoutLink ? { hangoutLink: r.hangoutLink } : {}),
	};
}

async function callApi<T>(path: string, init: RequestInit = {}): Promise<T> {
	const token = await getGoogleAccessToken();
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			...(init.headers as Record<string, string> | undefined),
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Calendar API ${res.status} on ${path}: ${body.slice(0, 300)}`);
	}
	return (await res.json()) as T;
}

export async function listEvents(opts: {
	timeMin?: string;
	timeMax?: string;
	maxResults?: number;
	calendarId?: string;
}): Promise<CalendarEvent[]> {
	const cal = opts.calendarId ?? "primary";
	const params = new URLSearchParams({
		singleEvents: "true",
		orderBy: "startTime",
		maxResults: String(opts.maxResults ?? 25),
	});
	if (opts.timeMin) params.set("timeMin", opts.timeMin);
	if (opts.timeMax) params.set("timeMax", opts.timeMax);
	const data = await callApi<{ items?: RawEvent[] }>(`/calendars/${encodeURIComponent(cal)}/events?${params}`);
	return (data.items ?? []).map(toEvent);
}

export async function createEvent(opts: {
	calendarId?: string;
	summary: string;
	description?: string;
	location?: string;
	startIso: string;
	endIso: string;
	attendees?: string[];
	timeZone?: string;
}): Promise<CalendarEvent> {
	const cal = opts.calendarId ?? "primary";
	const body: Record<string, unknown> = {
		summary: opts.summary,
		start: { dateTime: opts.startIso, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) },
		end: { dateTime: opts.endIso, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) },
	};
	if (opts.description) body.description = opts.description;
	if (opts.location) body.location = opts.location;
	if (opts.attendees?.length) body.attendees = opts.attendees.map((email) => ({ email }));
	const data = await callApi<RawEvent>(`/calendars/${encodeURIComponent(cal)}/events?sendUpdates=all`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return toEvent(data);
}

export async function deleteEvent(eventId: string, calendarId = "primary"): Promise<void> {
	const token = await getGoogleAccessToken();
	const res = await fetch(
		`${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
		{
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		},
	);
	if (!res.ok && res.status !== 410) {
		const body = await res.text();
		throw new Error(`Calendar delete ${res.status}: ${body.slice(0, 200)}`);
	}
}
