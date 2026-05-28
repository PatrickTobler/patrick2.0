import { insertSchedule, listSchedules } from "../db/repos/schedules.ts";
import { log } from "../log.ts";

interface SeededSchedule {
	/** Unique marker embedded in the prompt — used to detect "already seeded" idempotently. */
	marker: string;
	cron: string;
	timezone: string;
	prompt: string;
}

const TOKEN_USAGE_PROMPT = `[token-usage-report] This is an explicit daily reporting task — you MUST send the Telegram message. The usual "default to silence" rule does NOT apply here.

Call get_token_usage with hours=24 to get my LLM token spend for the last 24 hours. Then send_telegram_message with a short, plain-voice summary:
- Total tokens (with a rough in/out split) and estimated cost in USD for the last 24h.
- A one-line per-model breakdown (model: tokens, $).
- If spend is ~0, just say so in one line.
Keep it to a few lines. No preamble, no markdown headers.`;

const HEPHA_MONITOR_PROMPT = `[hepha-monitor] Daily health check of our Hepha autonomous coding-agent fleet. Only ping me if something needs attention — if everything is healthy, stay silent.

Hepha exposes a read-only HTTP API. Authenticate every request with this header:
  Authorization: Bearer hepha_mon_c15905342903d6dfdbac88fe10011432fc45ea65f5e75a9a

Step 1 — list tasks. Use run_shell with command "curl" and args as a list (no shell quoting):
  ["-s", "-H", "Authorization: Bearer hepha_mon_c15905342903d6dfdbac88fe10011432fc45ea65f5e75a9a", "https://coding-agent-mainnet.up.railway.app/api/tasks"]
This returns all tasks newest-first. Each has: task_id, status, repo_url, branch_name, pr_number, pr_url, preview_url, total_cost_usd, created_at, updated_at.

Step 2 — find problems. A task NEEDS ATTENTION if its status is one of: failed, auth_required, out_of_credits. (status completed WITH a pr_url = healthy finish; pending/running/cancelled = no action.)

Step 3 — for each problem task, fetch its detail + comment thread:
  ["-s", "-H", "Authorization: Bearer hepha_mon_c15905342903d6dfdbac88fe10011432fc45ea65f5e75a9a", "https://coding-agent-mainnet.up.railway.app/api/tasks/<task_id>?events=true"]
Read the newest entry in events[] (origin COWORKER = the agent, SOKOSUMI = the user) to understand what happened. If the response has eventsError instead of events, Sokosumi was briefly unreachable — note it and move on.

Step 4 — report:
- If there ARE problem tasks: send_telegram_message with a concise list. Per task: short task_id, status, repo, and a one-line summary of the latest comment / why it needs attention. Include pr_url if present.
- Check the "Previous runs" context above: do NOT re-report a task you already flagged unless its status has changed since.
- If nothing needs attention, send nothing.

Errors: HTTP 401 = the key was rejected (tell me once). 503 = monitoring not configured on the server (tell me once).`;

const SEEDED: SeededSchedule[] = [
	{ marker: "[token-usage-report]", cron: "0 21 * * *", timezone: "Europe/Zurich", prompt: TOKEN_USAGE_PROMPT },
	{ marker: "[hepha-monitor]", cron: "0 9 * * *", timezone: "Europe/Zurich", prompt: HEPHA_MONITOR_PROMPT },
];

/**
 * Idempotently ensure the built-in schedules exist. Matches on a marker substring in the prompt,
 * so a schedule is only (re)created when fully absent — if Patrick later edits or disables one,
 * we leave it alone. Best-effort: failures are logged, never thrown.
 */
export async function ensureSeededSchedules(): Promise<void> {
	let existing: Awaited<ReturnType<typeof listSchedules>>;
	try {
		existing = await listSchedules();
	} catch (err) {
		log.error({ err }, "seed schedules: listSchedules failed");
		return;
	}
	for (const s of SEEDED) {
		if (existing.some((row) => row.prompt.includes(s.marker))) continue;
		try {
			const row = await insertSchedule({ cron: s.cron, prompt: s.prompt, timezone: s.timezone });
			log.info({ scheduleId: row.id, marker: s.marker, cron: s.cron }, "seeded built-in schedule");
		} catch (err) {
			log.error({ err, marker: s.marker }, "seed schedules: insert failed");
		}
	}
}
