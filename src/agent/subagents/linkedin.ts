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

// LinkedIn doesn't offer a usable DM API for individual accounts. We drive
// linkedin.com via a stealth Browserbase Chromium session routed through
// Browserbase's residential proxies — same approach as the Reddit subagent.
//
// A Browserbase "context" stores cookies + localStorage across sessions —
// once Patrick logs in once (handling the 2FA challenge interactively via
// Telegram), the context persists and subsequent runs are already logged in.

const CONTEXT_ID_FILE = path.join(process.env.HOME ?? "/data/home", ".linkedin-browserbase-context-id");
// When the subagent gets blocked on 2FA, we persist the live session ID +
// connectUrl here so the next invocation (with the code) can reuse the same
// session that already has credentials submitted + the 2FA prompt visible.
// Without this, session 1 dies in the finally{} block and session 2 starts
// from scratch — only as good as whatever cookies got persisted to the
// Browserbase context, which is often not enough mid-2FA.
const SESSION_HANDOFF_FILE = path.join(process.env.HOME ?? "/data/home", ".linkedin-bb-session-handoff");
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
		log.warn({ err }, "failed to persist LinkedIn Browserbase context id");
	}
	return data.id;
}

async function createSession(apiKey: string, projectId: string, contextId: string): Promise<BrowserbaseSession> {
	const resp = await fetch(`${BB_API}/sessions`, {
		method: "POST",
		headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			projectId,
			// 30-min session — needs to span the LinkedIn login + 2FA + Patrick's
			// reply window (the project default is 300s = 5min which is too short
			// for a multi-step login that requires asking Patrick for the code).
			timeout: 1800,
			// keepAlive: true keeps the session alive even when the CDP WebSocket
			// disconnects between agent-browser calls. Without this, each
			// agent-browser command-then-disconnect cycle risks ending the session.
			keepAlive: true,
			browserSettings: {
				context: { id: contextId, persist: true },
			},
			// Switzerland — matches Patrick's normal login geography, minimises
			// LinkedIn's "unusual sign-in location" verifications. If Browserbase
			// rejects CH or LinkedIn still flags it, swap to "DE".
			proxies: [{ type: "browserbase", geolocation: { country: "CH" } }],
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

interface SavedSession {
	sessionId: string;
	connectUrl: string;
	savedAt: number;
}

async function readSavedSession(): Promise<SavedSession | null> {
	try {
		const raw = await fs.readFile(SESSION_HANDOFF_FILE, "utf-8");
		return JSON.parse(raw) as SavedSession;
	} catch {
		return null;
	}
}

async function saveSession(s: BrowserbaseSession): Promise<void> {
	try {
		await fs.mkdir(path.dirname(SESSION_HANDOFF_FILE), { recursive: true });
		await fs.writeFile(
			SESSION_HANDOFF_FILE,
			JSON.stringify({ sessionId: s.id, connectUrl: s.connectUrl, savedAt: Date.now() } satisfies SavedSession),
			"utf-8",
		);
	} catch (err) {
		log.warn({ err }, "linkedin session handoff persist failed");
	}
}

async function clearSavedSession(): Promise<void> {
	try {
		await fs.unlink(SESSION_HANDOFF_FILE);
	} catch {
		// not present, fine
	}
}

async function sessionStillAlive(apiKey: string, sessionId: string): Promise<boolean> {
	try {
		const resp = await fetch(`${BB_API}/sessions/${sessionId}`, { headers: { "X-BB-API-Key": apiKey } });
		if (!resp.ok) return false;
		const data = (await resp.json()) as { status?: string };
		return data.status === "RUNNING";
	} catch {
		return false;
	}
}

function buildSystemPrompt(email: string, password: string, connectUrl: string): string {
	return `You are patrick2.0's LinkedIn subagent — you drive a real Chromium session on Browserbase (stealth + residential proxy, CH geo) via the agent-browser CLI to interact with linkedin.com.

## Why browser, not API
LinkedIn's Messaging API is locked to enterprise partners (Salesforce/HubSpot tier). For personal DM read/reply, the website is the only path.

## How the session is set up
A fresh Browserbase session is already created. Connect to it by passing --cdp "${connectUrl}" on every agent-browser call. The session has:
- Stealth-patched Chromium fingerprint (bypasses LinkedIn's bot detection)
- Browserbase residential proxy in CH (matches Patrick's normal geography)
- Persistent context — once logged in, future runs skip login entirely

## Credentials (Patrick's account)
- Email:    ${email}
- Password: ${password}
Never print these back in your summary. Use them only to fill login forms.

## agent-browser cheatsheet
All commands run via run_shell command="agent-browser". Every call MUST include --cdp "${connectUrl}" AND timeout_ms: 120000 (default 30s is not enough — each call has a Browserbase round-trip).

Minimal working-set (each call needs --cdp "${connectUrl}"):
- Open URL:          run_shell agent-browser ["--cdp","${connectUrl}","open","https://www.linkedin.com/"]
- Snapshot (refs):   run_shell agent-browser ["--cdp","${connectUrl}","snapshot","-i","--json"]
- Click by ref:      run_shell agent-browser ["--cdp","${connectUrl}","click","@e3"]
- Fill by ref:       run_shell agent-browser ["--cdp","${connectUrl}","fill","@e2","hello"]
- Find by role+name: run_shell agent-browser ["--cdp","${connectUrl}","find","role","button","click","--name","Sign in"]
- Find by label:     run_shell agent-browser ["--cdp","${connectUrl}","find","label","Password","fill","PASSWORD"]
- Press key:         run_shell agent-browser ["--cdp","${connectUrl}","press","Enter"]
- Wait for URL:      run_shell agent-browser ["--cdp","${connectUrl}","wait","--url","**/feed/**"]
- Wait for text:     run_shell agent-browser ["--cdp","${connectUrl}","wait","--text","Messaging"]
- Get text:          run_shell agent-browser ["--cdp","${connectUrl}","get","text","@e5"]
- Get url:           run_shell agent-browser ["--cdp","${connectUrl}","get","url"]
- Screenshot:        run_shell agent-browser ["--cdp","${connectUrl}","screenshot","/tmp/linkedin.png"]

Do NOT call "close" — Browserbase session is released by the outer runtime when you finish.

## First-time login flow
The very first run goes through login + 2FA. Subsequent runs reuse cookies — skip to the task.

Step 0: open https://www.linkedin.com/feed/ and snapshot. If you see the messaging icon or "Start a post" or "My Network" → you're already logged in, skip to the task.

If not logged in (you land on /login or /uas/login):
1. open https://www.linkedin.com/login
2. find label "Email or phone" fill with the email above
3. find label "Password" fill with the password above
4. find role button click --name "Sign in"
5. wait 4000

After step 5, three possible outcomes — handle each:

A. **You land on /feed/** → logged in successfully. Proceed to the task.

B. **You see a 6-digit code prompt** (text like "Enter the 6-digit code from your authenticator app", "Two-step verification", or a field labelled "Verification code"). The Browserbase context is fresh — Patrick must hand off the 2FA code.
   STOP. Take a screenshot to /tmp/linkedin-2fa.png. Return EXACTLY:
   "Blocked — LinkedIn 2FA challenge. Ask Patrick for the current 6-digit code from his authenticator app and retry this task with the code included (e.g. 'log in with 2FA code 123456')."

C. **You see an "unusual sign-in / verify it's you" prompt** (SMS or email challenge, "Confirm it's you", "We noticed a sign-in from a new device"). STOP. Take a screenshot to /tmp/linkedin-verify.png. Return EXACTLY:
   "Blocked — LinkedIn 'unusual sign-in' verification. Patrick needs to log in manually from his usual browser once, then retry."

## Retry with 2FA code
When the task includes a 6-digit code (e.g. "log in with 2FA code 123456"):
1. open https://www.linkedin.com/login (or wherever the flow left off)
2. If still on credentials page, fill them again (steps 1-4 above)
3. Once on the 2FA page: find label / placeholder for the verification code, fill with the 6 digits
4. find role button click --name "Verify" / "Submit" / "Continue" (try in order)
5. wait --url "**/feed/**"
6. Confirm you're logged in via snapshot. Return "Logged in successfully. Context saved."

## Reading the DM inbox
1. open https://www.linkedin.com/messaging/
2. wait for the message list to load (text "Messaging" visible)
3. snapshot --json. Extract unread threads: sender name, last message snippet, timestamp.
4. Return as plain text, one thread per line:
   "UNREAD from <name>: <snippet> (<time>)"
   If no unread, return "Inbox empty — no unread messages."

## Reading a specific thread
1. From the messaging page, find the conversation by sender name (click on the thread).
2. Wait for the thread to load.
3. snapshot --json. Extract the last 10 messages (timestamp + author + body).
4. Return the conversation as plain text, oldest first.

## Sending a DM reply
The task will include the target person AND the exact message to send.
1. Open https://www.linkedin.com/messaging/
2. Click the thread for that person (find by name).
3. find role textbox click (the message compose area at the bottom).
4. Type the message (use fill or paste).
5. find role button click --name "Send" (or press Enter — but ONLY if the compose box has just one line; LinkedIn sometimes uses Enter for newlines).
6. Wait 2000. snapshot to confirm the message appears in the thread.
7. Return "Sent to <name>: <first 60 chars of the message>".

Never invent message text. If the task is vague ("reply to John"), STOP and return "Blocked — need exact message text".

## Hard rules
- Always pass --cdp "${connectUrl}". Never omit.
- Always pass timeout_ms: 120000 on run_shell for agent-browser.
- Do NOT pass -p, --headless, --proxy, --session-name, --init-script. --cdp overrides the provider.
- Never send a connection request, never follow anyone, never post on the feed, never react/like — DMs only.
- Never auto-reply. The task will explicitly say "send message X to Y" when a send is wanted.
- If two consecutive agent-browser calls fail (SIGTERM, non-zero exit, clear error), STOP and return "Blocked — agent-browser failed: <short reason>".
- Match Patrick's voice when drafting suggested replies (only when explicitly asked to draft): terse, direct, no fluff.

## Output contract
Return ONE plain-text paragraph starting with the outcome:
- "Inbox: <n> unread — <one-line summaries>"
- "Thread with <name>: <last messages as plain text>"
- "Sent to <name>: <preview>"
- "Logged in successfully. Context saved."
- "Blocked — <reason>"
No markdown, no emoji.`;
}

const Schema = Type.Object({
	task: Type.String({
		description:
			"The LinkedIn task in plain language. Be specific: 'check inbox and summarise unread', 'read the thread with Jane Doe', 'send to John Smith: thanks for the intro'. For first login or after a 2FA challenge: 'log in' or 'log in with 2FA code 123456'.",
		minLength: 5,
		maxLength: 4000,
	}),
});

export function makeLinkedinSubagentTool(): AgentTool<typeof Schema> {
	return {
		name: "delegate_to_linkedin",
		label: "Delegate to LinkedIn subagent",
		description:
			"Spawn a focused LinkedIn subagent that drives linkedin.com via a stealth Browserbase browser with residential proxies. Use for: reading the DM inbox, reading specific DM threads, sending DM replies (only when Patrick explicitly approves a draft). Login state persists across calls via a Browserbase context — first login needs Patrick's interactive 2FA code on Telegram. Returns a plain-text summary.",
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

			let session: BrowserbaseSession | null = null;
			let reusedExisting = false;
			try {
				// If a previous invocation got blocked on 2FA and saved its session, try
				// to reuse it — that's the only way the 2FA-code-comes-in-a-later-message
				// flow works (the live page still has credentials submitted + the 2FA
				// prompt waiting). If the saved session is dead, fall through to creating fresh.
				const saved = await readSavedSession();
				if (saved && (await sessionStillAlive(bbKey, saved.sessionId))) {
					session = { id: saved.sessionId, connectUrl: saved.connectUrl };
					reusedExisting = true;
					log.info({ sessionId: session.id }, "LinkedIn subagent reusing saved Browserbase session");
				} else {
					if (saved) await clearSavedSession();
					const contextId = await ensureContextId(bbKey, bbProject);
					session = await createSession(bbKey, bbProject, contextId);
					log.info({ sessionId: session.id, contextId }, "Browserbase session created for LinkedIn subagent");
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `LinkedIn subagent aborted — could not create Browserbase session: ${(err as Error).message}`,
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
						model: chooseModel("fast", cfg.openrouterApiKey),
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

				// 2FA handoff: if the subagent blocked specifically on 2FA, keep the
				// session alive (keepAlive: true on creation makes that work for ~30 min
				// per the timeout) and persist its id so the NEXT invocation
				// (with the code) reuses it. For any other outcome — success, error,
				// other blocker — release the session and clear any stale handoff.
				const finalText = result.finalText ?? "";
				const isTwoFactorBlock = /Blocked\s*[—-]\s*LinkedIn 2FA challenge/i.test(finalText);
				if (isTwoFactorBlock) {
					await saveSession(session);
				} else {
					await clearSavedSession();
					await releaseSession(bbKey, session.id);
				}

				const summary = `LinkedIn subagent done in ${result.turns} turns, ${result.toolCalls.length} tool calls (bb session ${session.id}${reusedExisting ? ", reused" : ""}).\n\n${result.finalText || "(no output)"}`;
				return {
					content: [{ type: "text", text: summary }],
					details: {
						turns: result.turns,
						toolCalls: result.toolCalls.length,
						errors: result.toolCalls.filter((c) => c.isError).length,
						bbSessionId: session.id,
						reusedSession: reusedExisting,
						handoffSaved: isTwoFactorBlock,
					},
				};
			} catch (err) {
				// On unexpected throw, always release + clear handoff
				await clearSavedSession();
				await releaseSession(bbKey, session.id);
				throw err;
			}
		},
	};
}
