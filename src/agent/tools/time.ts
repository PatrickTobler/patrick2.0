import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";

const NowSchema = Type.Object({
	tz: Type.Optional(
		Type.String({
			description: "IANA timezone like 'Europe/Zurich' or 'America/New_York'. Default: 'Europe/Zurich' (Patrick's tz).",
			maxLength: 40,
		}),
	),
});

const DEFAULT_TZ = "Europe/Zurich";

export const currentTimeTool: AgentTool<typeof NowSchema> = {
	name: "current_time",
	label: "Current time",
	description:
		"Get the current date and time in a given timezone (default Europe/Zurich, Patrick's tz). Call this BEFORE creating a todo with a relative due date like 'tomorrow' or 'in 3 hours' so you compute the correct absolute timestamp.",
	parameters: NowSchema,
	execute: async (_id, { tz }: Static<typeof NowSchema>) => {
		const zone = tz ?? DEFAULT_TZ;
		const now = new Date();
		const formatted = new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).format(now);
		return {
			content: [
				{
					type: "text",
					text: `Now: ${formatted} ${zone}\nUTC ISO: ${now.toISOString()}\nUnix: ${Math.floor(now.getTime() / 1000)}`,
				},
			],
			details: { iso: now.toISOString(), tz: zone, unix: Math.floor(now.getTime() / 1000) },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const timeTools: AgentTool<any>[] = [currentTimeTool];
