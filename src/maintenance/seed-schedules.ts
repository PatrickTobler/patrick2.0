import { insertSchedule, listSchedules, updateSchedule } from "../db/repos/schedules.ts";
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

Query the read-only Hepha API via the auth-wrapped helper script. It injects the bearer token from the server's environment, so you never see or handle the token. Use run_shell with command "node" and args as a list (the path argument must start with /api/):

Step 1 — list tasks:
  ["scripts/hepha-check.mjs", "/api/tasks"]
Returns all tasks newest-first. Each has: task_id, status, repo_url, branch_name, pr_number, pr_url, preview_url, total_cost_usd, created_at, updated_at.

Step 2 — find problems. A task NEEDS ATTENTION if its status is one of: failed, auth_required, out_of_credits. (status completed WITH a pr_url = healthy finish; pending/running/cancelled = no action.)

Step 3 — for each problem task, fetch its detail + comment thread:
  ["scripts/hepha-check.mjs", "/api/tasks/<task_id>?events=true"]
Read the newest entry in events[] (origin COWORKER = the agent, SOKOSUMI = the user) to understand what happened. If the response has eventsError instead of events, Sokosumi was briefly unreachable — note it and move on.

Step 4 — report:
- If there ARE problem tasks: send_telegram_message with a concise list. Per task: short task_id, status, repo, and a one-line summary of the latest comment / why it needs attention. Include pr_url if present.
- Check the "Previous runs" context above: do NOT re-report a task you already flagged unless its status has changed since.
- If nothing needs attention, send nothing.

Errors from the helper: "HTTP 401" = the monitoring key was rejected (tell me once). "HTTP 503" = monitoring not configured on the server (tell me once). "HEPHA_MONITOR_TOKEN is not set" = the env var is missing on this deploy (tell me once).`;

const SEEDED: SeededSchedule[] = [
	{ marker: "[token-usage-report]", cron: "0 21 * * *", timezone: "Europe/Zurich", prompt: TOKEN_USAGE_PROMPT },
	{ marker: "[hepha-monitor]", cron: "0 9 * * *", timezone: "Europe/Zurich", prompt: HEPHA_MONITOR_PROMPT },
];

/**
 * Ensure the built-in schedules exist and their prompts match the code. Matched by a marker
 * substring in the prompt:
 * - absent  → insert with the code's cron + prompt + timezone.
 * - present → the prompt is code-managed (single source of truth), so we sync it if it drifted
 *   (this is how a secret embedded in an old prompt gets scrubbed). We deliberately preserve the
 *   row's cron, timezone, and enabled flag, so rescheduling/disabling via Telegram survives deploys.
 * Best-effort: failures are logged, never thrown.
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
		const match = existing.find((row) => row.prompt.includes(s.marker));
		if (!match) {
			try {
				const row = await insertSchedule({ cron: s.cron, prompt: s.prompt, timezone: s.timezone });
				log.info({ scheduleId: row.id, marker: s.marker, cron: s.cron }, "seeded built-in schedule");
			} catch (err) {
				log.error({ err, marker: s.marker }, "seed schedules: insert failed");
			}
			continue;
		}
		if (match.prompt !== s.prompt) {
			try {
				await updateSchedule(match.id, { prompt: s.prompt });
				log.info({ scheduleId: match.id, marker: s.marker }, "synced built-in schedule prompt from code");
			} catch (err) {
				log.error({ err, marker: s.marker }, "seed schedules: prompt sync failed");
			}
		}
	}
}
