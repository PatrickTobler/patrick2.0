import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { type DailySummary, dailySummary } from "../../whoop/api.ts";
import { whoopConfigured } from "../../whoop/auth.ts";

const DaySchema = Type.Object({
	date: Type.String({
		description: "Date to fetch as YYYY-MM-DD. Use current_time to get today's date in Patrick's tz first.",
		minLength: 10,
		maxLength: 10,
	}),
});

function fmtDuration(min: number | null): string {
	if (min === null) return "—";
	const h = Math.floor(min / 60);
	const m = min % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmt(s: DailySummary): string {
	const lines = [
		`WHOOP ${s.date}`,
		`Recovery: ${s.recovery.score ?? "—"}%   HRV: ${s.recovery.hrv_ms ?? "—"} ms   RHR: ${s.recovery.rhr_bpm ?? "—"} bpm`,
		`Sleep:    score ${s.sleep.score_pct ?? "—"}%   ${fmtDuration(s.sleep.duration_min)} / ${fmtDuration(s.sleep.needed_min)} needed   eff ${s.sleep.efficiency_pct ?? "—"}%   consistency ${s.sleep.consistency_pct ?? "—"}%`,
		`Stages:   REM ${fmtDuration(s.sleep.stages_min.rem)} / Deep ${fmtDuration(s.sleep.stages_min.deep)} / Light ${fmtDuration(s.sleep.stages_min.light)} / Awake ${fmtDuration(s.sleep.stages_min.awake)}`,
		`Strain:   ${s.cycle.strain ?? "—"}   avg HR ${s.cycle.avg_hr ?? "—"}   max HR ${s.cycle.max_hr ?? "—"}`,
	];
	if (s.workouts.length > 0) {
		lines.push(`Workouts (${s.workouts.length}):`);
		for (const w of s.workouts) {
			lines.push(`  sport ${w.sport_id} | strain ${w.strain ?? "—"} | ${fmtDuration(w.duration_min)}`);
		}
	}
	return lines.join("\n");
}

export const whoopStatsTool: AgentTool<typeof DaySchema> = {
	name: "get_whoop_stats",
	label: "Get WHOOP daily stats",
	description:
		"Fetch Patrick's WHOOP recovery, sleep, strain and workouts for a specific date (YYYY-MM-DD) via the official WHOOP Developer API (OAuth, no raw credentials). Use this — never try to fetch app-internal.whoop.com URLs or run any local `whoop` binary; those paths are dead. Returns a structured summary (also available as `details` for chart-building); any field can be null when WHOOP hasn't computed it yet for the day (common mid-morning before sync).",
	parameters: DaySchema,
	execute: async (_id, { date }: Static<typeof DaySchema>) => {
		if (!whoopConfigured()) {
			return {
				content: [
					{
						type: "text",
						text: "WHOOP not configured — WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, or WHOOP_REFRESH_TOKEN missing. Tell Patrick to re-run the OAuth flow.",
					},
				],
				details: { error: "not_configured" },
			};
		}
		try {
			const s = await dailySummary(date);
			return { content: [{ type: "text", text: fmt(s) }], details: s };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { content: [{ type: "text", text: `WHOOP error: ${msg}` }], details: { error: msg } };
		}
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const whoopTools: AgentTool<any>[] = [whoopStatsTool];
