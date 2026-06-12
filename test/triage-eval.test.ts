import "dotenv/config";
import { describe, expect, it } from "vitest";

/**
 * Live-model eval for the email-triage classification policy. Cases are drawn from
 * real traffic (June 2026). Run explicitly — it costs a few cents and ~30s:
 *
 *   RUN_LLM_EVALS=1 npm test
 *
 * Purpose: schedule #12's prompt changes should be checked against the ACTUAL economy
 * model before shipping. DeepSeek follows examples, not intentions — this catches
 * policy wording that reads fine but misclassifies.
 */

const MODEL = "deepseek/deepseek-v4-flash";
const MIN_CORRECT = 13; // of 16 — allow some flake, catch real regressions

const POLICY = `You are an email triage classifier for Patrick (founder, works on Masumi Network / NMKR / agent infrastructure).
Classify the email into exactly one tier:
- URGENT: security alerts, money at risk, payments failing, replies Patrick must give within 24h, time-sensitive human questions directed at him.
- NOTABLE: personal messages, collaborator emails, meeting requests, partnership inquiries — worth knowing today, not worth interrupting for.
- BULK: newsletters, promotions, automated notifications, bot/CI noise, mailing-list event blasts, automated lead notifications.
Reply with EXACTLY one word: URGENT, NOTABLE, or BULK.`;

interface Case {
	email: string;
	expected: "URGENT" | "NOTABLE" | "BULK";
}

const CASES: Case[] = [
	{
		email:
			"From: LinkedIn Security <security-noreply@linkedin.com>\nSubject: New device login attempt\nBody: New sign-in attempt from Volketswil, Zurich on Chrome/Linux. If this wasn't you, change your password immediately.",
		expected: "URGENT",
	},
	{
		email:
			"From: Sentry <billing@sentry.io>\nSubject: Your credit card is expiring\nBody: The card on file for your organization expires this month. Update it to avoid service interruption and data loss on your error monitoring.",
		expected: "URGENT",
	},
	{
		email:
			"From: RST Datentechnik <buchhaltung@rst.de>\nSubject: Mahnung — Rechnung 202605110 überfällig\nBody: Final reminder: invoice from May 11 is overdue. Payment due within 3 days to avoid collection proceedings.",
		expected: "URGENT",
	},
	{
		email:
			"From: Aisha Kondo <events@gftn.org>\nSubject: RSVP closes tomorrow — Meet & Greet with Minister Alvin Tan\nBody: Reminder: your RSVP with CV and company write-up is due tomorrow for the June 22 Meet & Greet at Kongresshaus Zurich.",
		expected: "URGENT",
	},
	{
		email:
			"From: Dennis Trautwein <dennis@probelab.io>\nSubject: Great meeting you at the conference\nBody: Met you yesterday, discussed x402 and A2A. Want to stay in touch — will ping when funding for a collab is secured. Part of my team is in Berlin next week.",
		expected: "NOTABLE",
	},
	{
		email:
			"From: Luis Schaubhut <luis@allunity.com>\nSubject: Meeting invite: NMKR <> Cardano <> Allunity\nBody: Invite for Mon Jun 22 10:30-11:30 CEST, Google Meet. Attendance optional.",
		expected: "NOTABLE",
	},
	{
		email:
			"From: Tanja Tobler <tanja@gmx.de>\nSubject: Fwd: Grundbuchauszug Antrag\nBody: Forwarding the property records application from Hedwig — can you have a look when you get a chance?",
		expected: "NOTABLE",
	},
	{
		email:
			"From: Martyn Bacsigal <martyn@student.ethz.ch>\nSubject: Your German senate talk — slides?\nBody: I discussed Masumi with my professor, he was very interested in your senate talk. Could you share the slides or main topics?",
		expected: "NOTABLE",
	},
	{
		email:
			"From: Taha A <taha@bleedai.com>\nSubject: Sokosumi buyer segmentation — full strategy doc\nBody: Checked out Sokosumi after the Product Hunt launch. I have a full buyer-segmentation strategy built out — happy to send it over if useful.",
		expected: "NOTABLE",
	},
	{
		email:
			"From: Fergie Miller <fergie@iohk.io>\nSubject: Re: Masumi & research collab\nBody: Following up on the CV26 agent chains scope. Happy to pull in the relevant researcher for a call and explore future projects.",
		expected: "NOTABLE",
	},
	{
		email:
			"From: ESB Newsletter <news@esb-digital.de>\nSubject: Weekly digest: 10 trends in digital business\nBody: This week's top stories in digital transformation. Read online or unsubscribe below.",
		expected: "BULK",
	},
	{
		email:
			"From: FT Partners <research@ftpartners.com>\nSubject: Deal announcement: $240M Series C in payments infrastructure\nBody: FT Partners is pleased to announce another landmark fintech transaction. View the full deal profile.",
		expected: "BULK",
	},
	{
		email:
			"From: Luma <no-reply@lu.ma>\nSubject: You're invited: 0G Labs x Stanford Investor Demo Day\nBody: 10 decentralized AI startups presenting June 25. RSVP via Luma. Sent to subscribers of Apollo Accelerator events.",
		expected: "BULK",
	},
	{
		email:
			"From: GitHub <notifications@github.com>\nSubject: [masumi-network/registry] Dependabot: bump lodash from 4.17.20 to 4.17.21\nBody: Bumps lodash to fix a prototype pollution advisory. Merge or dismiss.",
		expected: "BULK",
	},
	{
		email:
			"From: Website Forms <forms@nmkr.io>\nSubject: New Free Analysis lead\nBody: Email: info@cut-print-service.de, Domain: shop-cut-print-service.de. Submitted via the free analysis form.",
		expected: "BULK",
	},
	{
		email:
			"From: Google Calendar <calendar-notification@google.com>\nSubject: Accepted: Sokosumi Daily @ Thu Jun 12\nBody: andreas has accepted this event.",
		expected: "BULK",
	},
];

async function classify(apiKey: string, email: string): Promise<string> {
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: MODEL,
			temperature: 0,
			max_tokens: 5,
			messages: [
				{ role: "system", content: POLICY },
				{ role: "user", content: email },
			],
		}),
	});
	if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return (json.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
}

const enabled = process.env.RUN_LLM_EVALS === "1" && !!process.env.OPENROUTER_API_KEY;

describe.runIf(enabled)("triage classification eval (live model)", () => {
	it(`classifies at least ${MIN_CORRECT}/${CASES.length} real-world cases correctly`, async () => {
		const apiKey = process.env.OPENROUTER_API_KEY as string;
		const results = await Promise.all(
			CASES.map(async (c) => {
				const got = await classify(apiKey, c.email);
				return { ...c, got, ok: got.startsWith(c.expected) };
			}),
		);
		const wrong = results.filter((r) => !r.ok);
		if (wrong.length > 0) {
			console.log("Misclassified:");
			for (const w of wrong) console.log(`  expected ${w.expected}, got ${w.got}: ${w.email.split("\n")[1]}`);
		}
		expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(MIN_CORRECT);
	}, 120_000);
});

describe.runIf(!enabled)("triage classification eval (skipped)", () => {
	it("is gated behind RUN_LLM_EVALS=1", () => {
		expect(true).toBe(true);
	});
});
