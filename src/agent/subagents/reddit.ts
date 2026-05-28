import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { getConfig } from "../../config.ts";
import { chooseModel } from "../../llm/router.ts";
import { log } from "../../log.ts";
import { factTools } from "../tools/facts.ts";
import { shellTools } from "../tools/shell.ts";
import { vaultTools } from "../tools/vault.ts";
import { runSubagent } from "./runner.ts";

// Reddit dropped API access and actively blocks automation. We work around this
// by driving a stealth Browserbase Chromium session that's ALSO routed through
// Browserbase's residential proxies — Reddit needs both a clean fingerprint AND
// a residential IP to let us through. agent-browser's built-in `-p browserbase`
// flag doesn't expose the proxies option, so we pre-create the session via the
// Browserbase API here and pass its CDP WebSocket URL to agent-browser via
// `--cdp <wss://...>`.
//
// A Browserbase "context" stores cookies/localStorage across sessions — we
// create one on first run and cache its ID on the Railway volume, so
// subsequent calls pick up the already-logged-in state.

const CONTEXT_ID_FILE = path.join(process.env.HOME ?? "/data/home", ".reddit-browserbase-context-id");
const BB_API = "https://api.browserbase.com/v1";

interface BrowserbaseSession {
	id: string;
	connectUrl: string;
}

async function ensureContextId(apiKey: string, projectId: string): Promise<string> {
	try {
		const cached = (await fs.readFile(CONTEXT_ID_FILE, "utf-8")).trim();
		if (cached) return cached;
	} catch {
		// fall through to create
	}
	const resp = await fetch(`${BB_API}/contexts`, {
		method: "POST",
		headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ projectId }),
	});
	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Browserbase create-context failed: ${resp.status} ${body}`);
	}
	const data = (await resp.json()) as { id: string };
	try {
		await fs.mkdir(path.dirname(CONTEXT_ID_FILE), { recursive: true });
		await fs.writeFile(CONTEXT_ID_FILE, data.id, "utf-8");
	} catch (err) {
		log.warn({ err }, "failed to persist Browserbase context id");
	}
	return data.id;
}

async function createSession(apiKey: string, projectId: string, contextId: string): Promise<BrowserbaseSession> {
	const resp = await fetch(`${BB_API}/sessions`, {
		method: "POST",
		headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			projectId,
			browserSettings: {
				context: { id: contextId, persist: true },
			},
			proxies: [{ type: "browserbase", geolocation: { country: "US" } }],
		}),
	});
	if (!resp.ok) {
		const body = await resp.text();
		throw new Error(`Browserbase create-session failed: ${resp.status} ${body}`);
	}
	const data = (await resp.json()) as { id: string; connectUrl: string };
	return data;
}

async function releaseSession(apiKey: string, sessionId: string): Promise<void> {
	try {
		await fetch(`${BB_API}/sessions/${sessionId}`, {
			method: "POST",
			headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ status: "REQUEST_RELEASE" }),
		});
	} catch (err) {
		log.warn({ err, sessionId }, "Browserbase release-session failed");
	}
}

function buildSystemPrompt(email: string, password: string, connectUrl: string): string {
	return `You are patrick2.0's Reddit subagent — you drive a real Chromium session on Browserbase (stealth + residential proxy) via the agent-browser CLI to interact with reddit.com.

## Why browser, not API
Reddit shut down third-party API access. Every action (post, comment, upvote, read inbox) goes through the actual website UI.

## How the session is set up
A fresh Browserbase session has already been created for this run. Connect to it by passing --cdp "${connectUrl}" on every agent-browser call. The session has:
- Stealth-patched Chromium fingerprint (bypasses Reddit's JS challenge)
- Browserbase residential proxy in US (bypasses Reddit's datacenter-IP block)
- Persistent "context" for cookies — once you log in, future runs will already be logged in

## Credentials (Patrick's account)
- Email:    ${email}
- Password: ${password}
Never print these back in your summary — just use them to fill login forms.

## agent-browser cheatsheet
All commands run through run_shell with command="agent-browser". Pass flags as args array. Every single call needs --cdp "${connectUrl}".

CRITICAL: every run_shell call to agent-browser MUST include timeout_ms: 120000. The default 30s is not enough — each command adds a network round-trip to Browserbase.

Minimal working-set of commands (every call MUST include --cdp "${connectUrl}"):
- Open URL:          run_shell agent-browser ["--cdp","${connectUrl}","open","https://www.reddit.com/"]
- Snapshot (refs):   run_shell agent-browser ["--cdp","${connectUrl}","snapshot","-i","--json"]
- Click by ref:      run_shell agent-browser ["--cdp","${connectUrl}","click","@e3"]
- Fill by ref:       run_shell agent-browser ["--cdp","${connectUrl}","fill","@e2","hello"]
- Find by role+name: run_shell agent-browser ["--cdp","${connectUrl}","find","role","button","click","--name","Post"]
- Find by label:     run_shell agent-browser ["--cdp","${connectUrl}","find","label","Password","fill","PASSWORD"]
- Press key:         run_shell agent-browser ["--cdp","${connectUrl}","press","Enter"]
- Wait for URL:      run_shell agent-browser ["--cdp","${connectUrl}","wait","--url","**/home"]
- Wait for text:     run_shell agent-browser ["--cdp","${connectUrl}","wait","--text","Your feed"]
- Get text:          run_shell agent-browser ["--cdp","${connectUrl}","get","text","@e5"]
- Get url:           run_shell agent-browser ["--cdp","${connectUrl}","get","url"]
- Screenshot:        run_shell agent-browser ["--cdp","${connectUrl}","screenshot","/tmp/reddit.png"]

Do NOT call "close" — the Browserbase session is managed by the outer runtime and released automatically when you finish.

## Login flow
First action of every task should be: open https://www.reddit.com/ and check whether you're logged in via snapshot (look for "Log In" button vs. user avatar). If logged in already (context persisted), skip straight to the task. If not:
1. open https://www.reddit.com/login
2. find placeholder "Email or username" fill with the email above
3. find placeholder "Password" fill with the password above
4. find role button click --name "Log in"
5. wait 5000 (let any redirect settle)
6. snapshot to confirm you're on the home page. If Reddit shows an error ("something went wrong", "server error", "try again"), STOP. Screenshot to /tmp/reddit-login-failed.png. Return "Blocked — Reddit login rejected (server error). Context will retry next run."
7. If you land on a captcha/2FA challenge: STOP. Return "Blocked — captcha at login, Patrick needs to resolve manually."

## Actions

### Read inbox
1. open https://www.reddit.com/message/inbox
2. snapshot --json, extract first 5-10 messages (author, subject, snippet)
3. Return as plain text.

### Read a subreddit feed
1. open https://www.reddit.com/r/{sub}/new/ (or /hot/)
2. snapshot --json, extract post titles + authors + upvote counts.
3. Return top N.

### Post to a subreddit
1. open https://www.reddit.com/r/{sub}/submit
2. Pick type (Text/Link) via find role tab click.
3. Fill title + body (text) OR title + url (link).
4. find role button click --name "Post".
5. wait --url "**/comments/**".
6. get url → include that in the summary.

### Comment on a post
1. open the post URL.
2. Click the "Join the conversation" / reply box, type the comment, submit.
3. Return the comment permalink if available.

### Upvote
1. open the post URL.
2. find role button click --name "upvote".

## Hard rules
- Always pass --cdp "${connectUrl}". Never omit.
- Always pass timeout_ms: 120000 on run_shell for agent-browser.
- Do NOT pass -p, --headless, --proxy, --session-name, --init-script. --cdp overrides the provider.
- If two consecutive agent-browser calls fail (SIGTERM, non-zero exit, or clear error text), STOP. Return "Blocked — agent-browser failed: <short reason>". Do NOT keep retrying forever.
- Never post anything Patrick didn't explicitly ask for.
- Match Patrick's voice: terse, direct, technical. Use list_facts if writing a post and unsure.

## Output contract
Return ONE plain-text paragraph starting with the outcome:
- "Posted to r/X: <title> → <url>"
- "Commented on <post>: <comment> → <url>"
- "Upvoted <post>"
- "Inbox: <n> messages — <summaries>"
- "Subreddit r/X: <top items>"
- "Blocked — <reason>"
No markdown, no emoji.`;
}

const Schema = Type.Object({
	task: Type.String({
		description:
			"The Reddit task in plain language. Be specific: target subreddit/URL, exact action, and any content. Example: 'Post a text submission to r/AI_Agents titled \"X\" with body \"Y\".' or 'Check my Reddit inbox and summarize the top 5 messages.'",
		minLength: 5,
		maxLength: 4000,
	}),
});

export function makeRedditSubagentTool(): AgentTool<typeof Schema> {
	return {
		name: "delegate_to_reddit",
		label: "Delegate to Reddit subagent",
		description:
			"Spawn a focused Reddit subagent that drives reddit.com via a stealth Browserbase browser with residential proxies. Use for: reading inbox, reading subreddit feeds, posting, commenting, upvoting. Login state persists across calls via a Browserbase context. Returns a plain-text summary.",
		parameters: Schema,
		execute: async (_id, { task }: Static<typeof Schema>) => {
			const cfg = getConfig();
			const email = process.env.REDDIT_EMAIL;
			const password = process.env.REDDIT_PASSWORD;
			const bbKey = process.env.BROWSERBASE_API_KEY;
			const bbProject = process.env.BROWSERBASE_PROJECT_ID;
			if (!email || !password || !bbKey || !bbProject) {
				return {
					content: [
						{
							type: "text",
							text: "Reddit subagent aborted — REDDIT_EMAIL, REDDIT_PASSWORD, BROWSERBASE_API_KEY, or BROWSERBASE_PROJECT_ID env var is not set.",
						},
					],
					details: { errors: 1 },
				};
			}

			let session: BrowserbaseSession | null = null;
			try {
				const contextId = await ensureContextId(bbKey, bbProject);
				session = await createSession(bbKey, bbProject, contextId);
				log.info({ sessionId: session.id, contextId }, "Browserbase session created for Reddit subagent");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Reddit subagent aborted — could not create Browserbase session: ${(err as Error).message}`,
						},
					],
					details: { errors: 1 },
				};
			}

			const WALL_CLOCK_MS = 5 * 60 * 1000;
			try {
				const result = await Promise.race([
					runSubagent({
						systemPrompt: buildSystemPrompt(email, password, session.connectUrl),
						model: chooseModel("economy", cfg.openrouterApiKey),
						tools: [...shellTools, ...vaultTools, ...factTools],
						prompt: task,
					}),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error(`Reddit subagent exceeded ${WALL_CLOCK_MS}ms wall clock`)),
							WALL_CLOCK_MS,
						),
					),
				]).catch((err: Error) => ({
					finalText: `Reddit subagent aborted — ${err.message}`,
					turns: -1,
					toolCalls: [] as { name: string; isError: boolean }[],
				}));

				const summary = `Reddit subagent done in ${result.turns} turns, ${result.toolCalls.length} tool calls (bb session ${session.id}).\n\n${result.finalText || "(no output)"}`;
				return {
					content: [{ type: "text", text: summary }],
					details: {
						turns: result.turns,
						toolCalls: result.toolCalls.length,
						errors: result.toolCalls.filter((c) => c.isError).length,
						bbSessionId: session.id,
					},
				};
			} finally {
				await releaseSession(bbKey, session.id);
			}
		},
	};
}
