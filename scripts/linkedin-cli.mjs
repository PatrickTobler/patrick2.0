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

async function obtainBrowser(apiKey, projectId, opts = { forceFresh: false }) {
	if (!opts.forceFresh) {
		const saved = readJsonFile(HANDOFF_FILE);
		if (saved?.sessionId && (await bbSessionAlive(apiKey, saved.sessionId))) {
			const browser = await chromium.connectOverCDP(saved.connectUrl);
			return { browser, session: saved, reused: true };
		}
		if (saved) tryUnlink(HANDOFF_FILE);
	}
	const contextId = await ensureContextId(apiKey, projectId);
	const session = await bbCreateSession(apiKey, projectId, contextId);
	const browser = await chromium.connectOverCDP(session.connectUrl);
	return { browser, session, reused: false };
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
	// Best signal: messaging icon is in the nav. We check via accessibility role
	// "link" with name containing "Messaging". On the feed/home, this is reliable.
	try {
		await page.waitForSelector('a[href*="/messaging/"]', { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
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
	const { browser, session, reused } = await obtainBrowser(apiKey, projectId, { forceFresh: !twoFaCode });
	let releaseOnExit = true;
	try {
		const page = await defaultPage(browser);

		// If reusing a session AND we have a 2FA code, the page should already be
		// on the challenge — just submit the code. Otherwise, do a fresh login.
		if (twoFaCode && reused) {
			// Make sure we're still on a challenge page
			const ch = await detectChallenge(page);
			if (ch?.kind === "2fa") {
				await submitTwoFactorCode(page, twoFaCode);
			} else {
				// Saved session is past the 2FA somehow — try to navigate to feed
				await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" }).catch(() => {});
			}
		} else {
			// Fresh login path: check current state first (might already be logged in via context cookies)
			await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
			if (!(await isLoggedIn(page))) {
				await submitLoginCredentials(page, email, password);
				if (twoFaCode) {
					// User passed --code on a fresh-session call; try submitting it on the challenge page
					const ch = await detectChallenge(page);
					if (ch?.kind === "2fa") await submitTwoFactorCode(page, twoFaCode);
				}
			}
		}

		if (await isLoggedIn(page)) {
			tryUnlink(HANDOFF_FILE);
			out({ status: "ok", action: "login", logged_in: true, reused });
			return;
		}

		const ch = await detectChallenge(page);
		if (ch?.kind === "2fa") {
			writeJsonFileAtomic(HANDOFF_FILE, { sessionId: session.id, connectUrl: session.connectUrl, savedAt: Date.now() });
			releaseOnExit = false;
			out({ status: "blocked", reason: "2fa", message: "LinkedIn 2FA challenge — pass --code <6-digit> on the next call to continue." });
			return;
		}
		if (ch?.kind === "unusual") {
			out({ status: "blocked", reason: "unusual-signin", message: "LinkedIn 'unusual sign-in' verification — Patrick must complete one manual login from his usual browser first." });
			return;
		}
		out({ status: "blocked", reason: "unknown", message: `Did not land on feed and no 2FA prompt detected. URL=${page.url()}` });
	} finally {
		await browser.close().catch(() => {});
		if (releaseOnExit) await bbReleaseSession(apiKey, session.id);
	}
}

async function cmdInbox(apiKey, projectId) {
	const { browser, session } = await obtainBrowser(apiKey, projectId);
	try {
		const page = await defaultPage(browser);
		await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!(await isLoggedIn(page))) {
			out({ status: "blocked", reason: "not-logged-in", message: "Run login first." });
			return;
		}
		await page.waitForSelector(".msg-conversations-container__convo-item", { timeout: 15000 }).catch(() => {});
		// Pull unread threads — LinkedIn marks unread rows with a dot indicator class
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
		out({ status: "ok", action: "inbox", total_visible: threads.length, unread_count: unread.length, unread });
	} finally {
		await browser.close().catch(() => {});
		await bbReleaseSession(apiKey, session.id);
	}
}

async function cmdThread(apiKey, projectId, name) {
	if (!name) throw new Error("--name required");
	const { browser, session } = await obtainBrowser(apiKey, projectId);
	try {
		const page = await defaultPage(browser);
		await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!(await isLoggedIn(page))) {
			out({ status: "blocked", reason: "not-logged-in", message: "Run login first." });
			return;
		}
		// Click the convo with the matching participant name
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
		out({ status: "ok", action: "thread", participant: name, messages });
	} finally {
		await browser.close().catch(() => {});
		await bbReleaseSession(apiKey, session.id);
	}
}

async function cmdSend(apiKey, projectId, name, text) {
	if (!name) throw new Error("--name required");
	if (!text) throw new Error("--text required");
	const { browser, session } = await obtainBrowser(apiKey, projectId);
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
		// Click Send (LinkedIn's send button is role=button name=Send)
		const sendBtn = page.locator('button:has-text("Send"), button[aria-label*="Send"]').first();
		await sendBtn.click({ timeout: 5000 });
		// Wait for the message to appear in the thread
		await page.waitForTimeout(2000);
		out({ status: "ok", action: "send", to: name, preview: text.slice(0, 80) });
	} finally {
		await browser.close().catch(() => {});
		await bbReleaseSession(apiKey, session.id);
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
