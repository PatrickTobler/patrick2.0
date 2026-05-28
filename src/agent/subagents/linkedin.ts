import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { chooseModel } from "../../llm/router.ts";
import { factTools } from "../tools/facts.ts";
import { shellTools } from "../tools/shell.ts";
import { vaultTools } from "../tools/vault.ts";
import { runSubagent } from "./runner.ts";

// LinkedIn DMs require browser automation (no usable official API for personal
// accounts). The previous agent-browser-based implementation hit a regression
// where the CDP launcher 410s against Browserbase even though raw WebSocket
// connect works.
//
// This version drives Playwright (chromium.connectOverCDP) directly via a
// self-contained Node script at scripts/linkedin-cli.mjs. The subagent
// becomes a thin wrapper: it just invokes the script with the right command
// and surfaces the JSON output back to the main agent.

function buildSystemPrompt(): string {
	return `You are patrick2.0's LinkedIn subagent. You drive linkedin.com via a Node helper script that uses Playwright over Browserbase CDP. You do NOT call agent-browser, never fetch URLs manually, never invent commands.

## The only tool you use
\`run_shell command="node" args=["/app/scripts/linkedin-cli.mjs", <cmd>, ...flags]\`

Every call has timeout_ms: 90000 (90s). The script returns ONE JSON object on stdout — your job is to parse it and return a single-line plain-text summary.

## Commands the script supports

1. **Login** (fresh session, fills creds, detects 2FA challenge):
   node /app/scripts/linkedin-cli.mjs login
   On success → \`{"status":"ok","action":"login","logged_in":true,...}\`
   On 2FA challenge → \`{"status":"blocked","reason":"2fa","message":"..."}\` (the script PERSISTS the session for the next call)
   On unusual-signin → \`{"status":"blocked","reason":"unusual-signin","message":"..."}\`

2. **Continue login with 2FA code** (reuses persisted session):
   node /app/scripts/linkedin-cli.mjs login --code 123456
   On success → \`{"status":"ok",...,"logged_in":true}\`

3. **Inbox** (list unread DMs):
   node /app/scripts/linkedin-cli.mjs inbox
   Returns \`{"status":"ok","action":"inbox","unread_count":N,"unread":[{name,preview,time},...]}\`

4. **Read a thread** (last 10 messages):
   node /app/scripts/linkedin-cli.mjs thread --name "Jane Doe"
   Returns \`{"status":"ok","messages":[{author,time,body},...]}\`

5. **Send a reply** (ONLY when Patrick has explicitly approved the exact text):
   node /app/scripts/linkedin-cli.mjs send --name "John" --text "<the exact message>"
   Returns \`{"status":"ok","action":"send","to":"John","preview":"..."}\`

## Routing the task

Look at the task text and pick ONE command:
- "log in" / "login" / "sign in" → command 1
- "log in with 2FA code 123456" / contains a 6-digit code → command 2 (extract digits, pass as --code)
- "check inbox" / "read DMs" / "list unread" → command 3
- "open thread with X" / "read messages from X" → command 4 with --name "X"
- "send to X: <message>" / "reply to X with <message>" → command 5 with --name "X" --text "<message>"

If a task is ambiguous (no name, no message, etc.), STOP and return "Blocked — need <missing piece>".

## Output contract
Return ONE plain-text line. No JSON, no markdown, no emoji.
- "Logged in successfully."
- "Blocked — LinkedIn 2FA challenge. Ask Patrick for the current 6-digit code from his authenticator app and retry this task as 'log in with 2FA code XXXXXX'."
- "Blocked — LinkedIn 'unusual sign-in' verification. Patrick needs to log in manually from his usual browser once, then retry."
- "Inbox: N unread — <name>: <preview> (<time>); <name>: <preview>..."
- "Thread with X — N messages: <author>: <body excerpt>; ..."
- "Sent to X: <first 60 chars>"
- "Blocked — <other reason>"

## Hard rules
- NEVER auto-reply. Only send when the task contains the EXACT message Patrick wrote.
- NEVER call agent-browser or any other browser tool. Only the linkedin-cli.mjs script.
- One run_shell call should usually be enough. If the first call's status is "blocked", do NOT retry — return the blocked summary verbatim. If it's "error", do NOT retry — return "Blocked — script error: <message>".`;
}

const Schema = Type.Object({
	task: Type.String({
		description:
			"The LinkedIn task in plain language. Examples: 'log in', 'log in with 2FA code 123456', 'check unread DMs', 'open thread with Jane Doe', 'send to John Smith: thanks for the intro'.",
		minLength: 5,
		maxLength: 4000,
	}),
});

export function makeLinkedinSubagentTool(): AgentTool<typeof Schema> {
	return {
		name: "delegate_to_linkedin",
		label: "Delegate to LinkedIn subagent",
		description:
			"Spawn a focused LinkedIn subagent that drives linkedin.com via Playwright over Browserbase CDP. Use for: reading DM inbox, reading specific DM threads, sending DM replies (only when Patrick explicitly approves a draft). Login state persists across calls via a Browserbase context — first login needs Patrick's interactive 2FA code on Telegram. Returns a plain-text summary.",
		parameters: Schema,
		execute: async (_id, { task }: Static<typeof Schema>) => {
			const cfg = getConfig();
			const email = process.env.LINKEDIN_EMAIL;
			const password = process.env.LINKEDIN_PASSWORD;
			const bbKey = process.env.BROWSERBASE_API_KEY;
			const bbProject = process.env.BROWSERBASE_PROJECT_ID;
			if (!email || !password || !bbKey || !bbProject) {
				return {
					content: [
						{
							type: "text",
							text: "LinkedIn subagent aborted — LINKEDIN_EMAIL, LINKEDIN_PASSWORD, BROWSERBASE_API_KEY, or BROWSERBASE_PROJECT_ID env var is not set.",
						},
					],
					details: { errors: 1 },
				};
			}

			const WALL_CLOCK_MS = 3 * 60 * 1000; // 3 min — Playwright flow is much faster than agent-browser
			const result = await Promise.race([
				runSubagent({
					systemPrompt: buildSystemPrompt(),
					model: chooseModel("economy", cfg.openrouterApiKey),
					tools: [...shellTools, ...vaultTools, ...factTools],
					prompt: task,
				}),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`LinkedIn subagent exceeded ${WALL_CLOCK_MS}ms wall clock`)),
						WALL_CLOCK_MS,
					),
				),
			]).catch((err: Error) => ({
				finalText: `LinkedIn subagent aborted — ${err.message}`,
				turns: -1,
				toolCalls: [] as { name: string; isError: boolean }[],
			}));

			const summary = `LinkedIn subagent done in ${result.turns} turns, ${result.toolCalls.length} tool calls.\n\n${result.finalText || "(no output)"}`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					turns: result.turns,
					toolCalls: result.toolCalls.length,
					errors: result.toolCalls.filter((c) => c.isError).length,
				},
			};
		},
	};
}
