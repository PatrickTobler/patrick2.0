#!/usr/bin/env node
// Self-contained LinkedIn ops via Playwright + Browserbase CDP (skips
// agent-browser CLI entirely — its CDP launcher has been flaky against
// Browserbase). Invoked by the LinkedIn subagent via run_shell.
//
// Commands (single positional arg + optional flags):
//   linkedin-cli.mjs login                       — submit creds, detect 2FA
//   linkedin-cli.mjs login --code 123456         — continue with 2FA code (reuses session)
//   linkedin-cli.mjs inbox                       — list unread DMs
//   linkedin-cli.mjs thread --name "Jane Doe"    — read last 10 messages in thread
//   linkedin-cli.mjs send --name "John" --text "..." — send a reply
//
// Output: one JSON object on stdout, exit 0 on success. On any blocker that
// needs Patrick (2FA challenge, unusual-sign-in verification, etc.) we exit 0
// with status="blocked" and a reason so the subagent can surface it cleanly.
// True errors (auth misconfig, Playwright fail) exit 1 with status="error".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const HOME = process.env.HOME ?? "/data/home";
const HANDOFF_FILE = join(HOME, ".linkedin-bb-session-handoff");
const CONTEXT_FILE = join(HOME, ".linkedin-browserbase-context-id");
const BB_API = "https://api.browserbase.com/v1";

function out(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function writeJsonFileAtomic(path, body) {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		// best-effort
		console.error("persist failed:", err.message);
	}
}

function tryUnlink(path) {
	try {
		if (existsSync(path)) {
			const fs = require("node:fs");
			fs.unlinkSync(path);
		}
	} catch {
		// ignore
	}
}

// --- Browserbase session helpers ---

async function bbCreateContext(apiKey, projectId) {
	const r = await fetch(`${BB_API}/contexts`, {
		method: "POST",
		headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ projectId }),
	});
	if (!r.ok) throw new Error(`BB create-context: ${r.status} ${await r.text()}`);
	return (await r.json()).id;
}

async function ensureContextId(apiKey, projectId) {
	const cached = readJsonFile(CONTEXT_FILE);
	if (cached?.contextId) return cached.contextId;
	const contextId = await bbCreateContext(apiKey, projectId);
	writeJsonFileAtomic(CONTEXT_FILE, { contextId });
	return contextId;
}

async function bbCreateSession(apiKey, projectId, contextId) {
	const r = await fetch(`${BB_API}/sessions`, {
		method: "POST",
		headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			projectId,
			timeout: 1800, // 30 min — spans login + 2FA-ask-Patrick window
			keepAlive: true, // survives CDP disconnects
			browserSettings: { context: { id: contextId, persist: true } },
			proxies: [{ type: "browserbase", geolocation: { country: "CH" } }],
		}),
	});
	if (!r.ok) throw new Error(`BB create-session: ${r.status} ${await r.text()}`);
	return await r.json();
}

async function bbSessionAlive(apiKey, sessionId) {
	try {
		const r = await fetch(`${BB_API}/sessions/${sessionId}`, { headers: { "X-BB-API-Key": apiKey } });
		if (!r.ok) return false;
		const d = await r.json();
		return d.status === "RUNNING";
	} catch {
		return false;
	}
}

async function bbReleaseSession(apiKey, sessionId) {
	try {
		await fetch(`${BB_API}/sessions/${sessionId}`, {
			method: "POST",
			headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ status: "REQUEST_RELEASE" }),
		});
	} catch {
		// best-effort
	}
}

// --- Get a Playwright browser+page, reusing saved session if available ---
//
// Strategy: ALWAYS try to reuse a saved session. Only force a fresh one when
// the caller explicitly asks (e.g. they're trying to clear stuck state). After
// any successful op, the caller persists the session via persistSession() —
// so e.g. `login` followed by `inbox` 60 seconds later runs entirely inside
// one Browserbase session that's already on the feed.
//
// Sessions auto-die when their 30-min timeout elapses (we set timeout: 1800
// + keepAlive: true). At that point bbSessionAlive returns false on the next
// call and we transparently spin up a fresh one (cookies from the persistent
// Browserbase context survive across sessions).

async function obtainBrowser(apiKey, projectId, opts = { forceFresh: false }) {
	if (!opts.forceFresh) {
		const saved = readJsonFile(HANDOFF_FILE);
		if (saved?.sessionId && (await bbSessionAlive(apiKey, saved.sessionId))) {
			try {
				const browser = await chromium.connectOverCDP(saved.connectUrl);
				return { browser, session: saved, reused: true };
			} catch {
				// Saved session ID is alive per the API but CDP connect failed —
				// likely the connectUrl's signing key expired even though the session
				// hasn't timed out. Fall through to a fresh session.
			}
		}
		if (saved) tryUnlink(HANDOFF_FILE);
	}
	const contextId = await ensureContextId(apiKey, projectId);
	const session = await bbCreateSession(apiKey, projectId, contextId);
	const browser = await chromium.connectOverCDP(session.connectUrl);
	return { browser, session, reused: false };
}

function persistSession(session) {
	writeJsonFileAtomic(HANDOFF_FILE, {
		sessionId: session.id ?? session.sessionId,
		connectUrl: session.connectUrl,
		savedAt: Date.now(),
	});
}

async function defaultPage(browser) {
	const contexts = browser.contexts();
	const ctx = contexts[0];
	if (!ctx) throw new Error("Browserbase session has no default context");
	const pages = ctx.pages();
	const page = pages[0] ?? (await ctx.newPage());
	return page;
}

// --- Args parsing ---

function parseArgs(argv) {
	const cmd = argv[2];
	const flags = {};
	for (let i = 3; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		}
	}
	return { cmd, flags };
}

// --- LinkedIn flows ---

async function isLoggedIn(page) {
	// Multiple positive signals. Each tried with a short timeout — we want this
	// fast on either outcome. If none match within ~10s total, treat as not
	// logged in.
	const signals = [
		'a[href*="/messaging/"]',
		'a[href*="/feed/"]',
		'.global-nav__me, button[data-control-name="nav.settings_signout"]',
	];
	for (const sel of signals) {
		try {
			await page.waitForSelector(sel, { timeout: 3500 });
			return true;
		} catch {
			// next signal
		}
	}
	// Also: if we're on /login or /uas/login we're definitely NOT logged in
	const url = page.url();
	if (/login|checkpoint|challenge|uas\//.test(url)) return false;
	return false;
}

async function detectChallenge(page) {
	const url = page.url();
	if (/checkpoint|challenge/.test(url)) {
		// Try to read the page heading / instructions
		const heading = await page.locator("h1, h2").first().textContent().catch(() => "");
		if (/two-step|verification code|enter the code|authenticator/i.test(heading ?? "")) {
			return { kind: "2fa", heading: heading?.trim() };
		}
		if (/verify|unusual|we noticed|confirm it's you/i.test(heading ?? "")) {
			return { kind: "unusual", heading: heading?.trim() };
		}
		return { kind: "unknown-challenge", heading: heading?.trim(), url };
	}
	// 2FA prompts can also live at /login-submit/ — check for a "verification code" input
	const codeInput = await page
		.locator('input[name="pin"], input[name="challenge-response"], input[autocomplete="one-time-code"]')
		.first()
		.count()
		.catch(() => 0);
	if (codeInput > 0) return { kind: "2fa", heading: "Verification code prompt" };
	return null;
}

async function submitLoginCredentials(page, email, password) {
	await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.locator('input[name="session_key"]').fill(email);
	await page.locator('input[name="session_password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	// Either land on feed, on a challenge, or on an error
	await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

async function submitTwoFactorCode(page, code) {
	// Find the 2FA code input — multiple possible selectors across LinkedIn variants
	const input = page
		.locator(
			'input[name="pin"], input[name="challenge-response"], input[autocomplete="one-time-code"], input[id*="verification"]',
		)
		.first();
	await input.fill(code, { timeout: 10000 });
	// The submit button text varies — "Submit", "Verify", "Continue"
	const submit = page
		.locator('button[type="submit"]:visible, button:has-text("Submit"):visible, button:has-text("Verify"):visible, button:has-text("Continue"):visible')
		.first();
	await submit.click();
	await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

async function cmdLogin(apiKey, projectId, email, password, twoFaCode) {
	// For login WITHOUT a 2FA code: try reuse first (cookies might have us
	// already logged in). For login WITH a 2FA code: MUST reuse — the saved
	// session is on the 2FA prompt waiting.
	const forceFresh = false;
	const { browser, session, reused } = await obtainBrowser(apiKey, projectId, { forceFresh });
	let outcome = "unknown";
	try {
		const page = await defaultPage(browser);

		if (twoFaCode && reused) {
			const ch = await detectChallenge(page);
			if (ch?.kind === "2fa") {
				await submitTwoFactorCode(page, twoFaCode);
			} else {
				await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" }).catch(() => {});
			}
		} else {
			await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
			if (!(await isLoggedIn(page))) {
				await submitLoginCredentials(page, email, password);
				if (twoFaCode) {
					const ch = await detectChallenge(page);
					if (ch?.kind === "2fa") await submitTwoFactorCode(page, twoFaCode);
				}
			}
		}

		if (await isLoggedIn(page)) {
			// Persist this session so subsequent calls (inbox, send, etc.) can
			// reuse the already-logged-in browser instead of creating a new one
			// and re-checking cookies.
			persistSession(session);
			outcome = "ok";
			out({ status: "ok", action: "login", logged_in: true, reused, sessionId: session.id });
			return;
		}

		const ch = await detectChallenge(page);
		if (ch?.kind === "2fa") {
			// Session is on the 2FA prompt — persist so the next call's --code
			// lands on the same page.
			persistSession(session);
			outcome = "blocked-2fa";
			out({ status: "blocked", reason: "2fa", message: "LinkedIn 2FA challenge — pass --code <6-digit> on the next call to continue." });
			return;
		}
		if (ch?.kind === "unusual") {
			outcome = "blocked-unusual";
			out({ status: "blocked", reason: "unusual-signin", message: "LinkedIn 'unusual sign-in' verification — Patrick must complete one manual login from his usual browser first." });
			return;
		}
		outcome = "blocked-unknown";
		out({ status: "blocked", reason: "unknown", message: `Did not land on feed and no 2FA prompt detected. URL=${page.url()}` });
	} finally {
		await browser.close().catch(() => {});
		// Only release the session if we DEFINITELY can't reuse it later
		// (unusual-signin or unknown blocker). For "ok" and "blocked-2fa" we
		// already persisted via persistSession() and want the session alive.
		if (outcome === "blocked-unusual" || outcome === "blocked-unknown") {
			tryUnlink(HANDOFF_FILE);
			await bbReleaseSession(apiKey, session.id);
		}
	}
}

async function cmdInbox(apiKey, projectId) {
	const { browser, session } = await obtainBrowser(apiKey, projectId);
	let ok = false;
	try {
		const page = await defaultPage(browser);
		await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!(await isLoggedIn(page))) {
			out({ status: "blocked", reason: "not-logged-in", message: "Run login first." });
			return;
		}
		await page.waitForSelector(".msg-conversations-container__convo-item", { timeout: 15000 }).catch(() => {});
		const threads = await page.evaluate(() => {
			const items = Array.from(document.querySelectorAll(".msg-conversations-container__convo-item"));
			return items.slice(0, 30).map((el) => {
				const isUnread = !!el.querySelector(".notification-badge--show, .msg-conversation-card__unread-indicator");
				const name = el.querySelector(".msg-conversation-listitem__participant-names")?.textContent?.trim() || "";
				const preview = el.querySelector(".msg-conversation-card__message-snippet")?.textContent?.trim() || "";
				const time = el.querySelector(".msg-conversation-listitem__time-stamp, time")?.textContent?.trim() || "";
				return { unread: isUnread, name, preview, time };
			});
		});
		const unread = threads.filter((t) => t.unread);
		ok = true;
		out({ status: "ok", action: "inbox", total_visible: threads.length, unread_count: unread.length, unread });
	} finally {
		await browser.close().catch(() => {});
		if (ok) {
			persistSession(session);
		} else {
			tryUnlink(HANDOFF_FILE);
			await bbReleaseSession(apiKey, session.id);
		}
	}
}

async function cmdThread(apiKey, projectId, name) {
	if (!name) throw new Error("--name required");
	const { browser, session } = await obtainBrowser(apiKey, projectId);
	let ok = false;
	try {
		const page = await defaultPage(browser);
		await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!(await isLoggedIn(page))) {
			out({ status: "blocked", reason: "not-logged-in", message: "Run login first." });
			return;
		}
		const convo = page
			.locator(".msg-conversations-container__convo-item")
			.filter({ hasText: name })
			.first();
		await convo.click({ timeout: 10000 });
		await page.waitForSelector(".msg-s-event-listitem", { timeout: 10000 }).catch(() => {});
		const messages = await page.evaluate(() => {
			const items = Array.from(document.querySelectorAll(".msg-s-event-listitem"));
			return items.slice(-10).map((el) => ({
				author: el.querySelector(".msg-s-message-group__name")?.textContent?.trim() || "",
				time: el.querySelector("time")?.textContent?.trim() || "",
				body: el.querySelector(".msg-s-event-listitem__body")?.textContent?.trim() || "",
			}));
		});
		ok = true;
		out({ status: "ok", action: "thread", participant: name, messages });
	} finally {
		await browser.close().catch(() => {});
		if (ok) persistSession(session);
		else {
			tryUnlink(HANDOFF_FILE);
			await bbReleaseSession(apiKey, session.id);
		}
	}
}

async function cmdSend(apiKey, projectId, name, text) {
	if (!name) throw new Error("--name required");
	if (!text) throw new Error("--text required");
	const { browser, session } = await obtainBrowser(apiKey, projectId);
	let ok = false;
	try {
		const page = await defaultPage(browser);
		await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!(await isLoggedIn(page))) {
			out({ status: "blocked", reason: "not-logged-in", message: "Run login first." });
			return;
		}
		const convo = page
			.locator(".msg-conversations-container__convo-item")
			.filter({ hasText: name })
			.first();
		await convo.click({ timeout: 10000 });
		const composer = page.locator(".msg-form__contenteditable").first();
		await composer.click({ timeout: 10000 });
		await composer.type(text, { delay: 20 });
		const sendBtn = page.locator('button:has-text("Send"), button[aria-label*="Send"]').first();
		await sendBtn.click({ timeout: 5000 });
		await page.waitForTimeout(2000);
		ok = true;
		out({ status: "ok", action: "send", to: name, preview: text.slice(0, 80) });
	} finally {
		await browser.close().catch(() => {});
		if (ok) persistSession(session);
		else {
			tryUnlink(HANDOFF_FILE);
			await bbReleaseSession(apiKey, session.id);
		}
	}
}

// --- Entrypoint ---

async function main() {
	const apiKey = process.env.BROWSERBASE_API_KEY;
	const projectId = process.env.BROWSERBASE_PROJECT_ID;
	if (!apiKey || !projectId) {
		out({ status: "error", reason: "config", message: "BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID missing" });
		process.exit(1);
	}

	const { cmd, flags } = parseArgs(process.argv);

	try {
		if (cmd === "login") {
			const email = process.env.LINKEDIN_EMAIL;
			const password = process.env.LINKEDIN_PASSWORD;
			if (!email || !password) throw new Error("LINKEDIN_EMAIL or LINKEDIN_PASSWORD missing");
			await cmdLogin(apiKey, projectId, email, password, flags.code || null);
		} else if (cmd === "inbox") {
			await cmdInbox(apiKey, projectId);
		} else if (cmd === "thread") {
			await cmdThread(apiKey, projectId, flags.name);
		} else if (cmd === "send") {
			await cmdSend(apiKey, projectId, flags.name, flags.text);
		} else {
			out({ status: "error", reason: "bad-args", message: "Commands: login [--code], inbox, thread --name, send --name --text" });
			process.exit(1);
		}
	} catch (err) {
		out({ status: "error", reason: "exception", message: err.message ?? String(err) });
		process.exit(1);
	}
}

main();
