import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { type ActionRow, insertPendingAction, listActionsByToolPrefix, resolveAction } from "../db/repos/actions.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";
import { ingestFactsFromMessage } from "./facts.ts";
import { buildRecallContext, buildStableSystemPrompt } from "./memory-context.ts";
import { makeCoderSubagentTool } from "./subagents/coder.ts";
import { makeLinkedinSubagentTool } from "./subagents/linkedin.ts";
import {
	duneSubagentSpec,
	githubSubagentSpec,
	linearSubagentSpec,
	makeMcpDomainSubagent,
	webSubagentSpec,
} from "./subagents/mcp-domain.ts";
import { makeMoltbookSubagentTool } from "./subagents/moltbook.ts";
import { makeResearcherSubagentTool } from "./subagents/researcher.ts";
import { actionTools } from "./tools/actions.ts";
import { calendarTools } from "./tools/calendar.ts";
import { factTools } from "./tools/facts.ts";
import { gmailTools } from "./tools/gmail.ts";
import { mcpMetaTools } from "./tools/mcp-meta.ts";
import { shellTools } from "./tools/shell.ts";
import { skillTools } from "./tools/skills.ts";
import { telegramTools } from "./tools/telegram.ts";
import { thinkingTools } from "./tools/thinking.ts";
import { timeTools } from "./tools/time.ts";
import { usageTools } from "./tools/usage.ts";
// Native todos disabled — Patrick uses Linear (via MCP) instead.
import { vaultTools } from "./tools/vault.ts";
import { whoopTools } from "./tools/whoop.ts";
import { recordUsageFromMessages } from "./usage-tracking.ts";

const SCHEDULED_BANNER = `
You are running on a schedule — Patrick did NOT just message you. This is autonomous time.

## Default behavior: silence
- Do NOT send_telegram_message to confirm you ran. Patrick audits via query_actions.
- The "user" message below is the scheduled prompt — instructions, not a conversation.
- EXCEPTION — explicit-send tasks: if the scheduled prompt itself tells you to send a message (a reminder, a report, a brief), then sending IS the task and the silence default does NOT apply. A reminder that stays silent has failed its only job. Dedup still applies to everything else in the run, but never dedup away the message the schedule exists to send.

## When you MAY ping Patrick on Telegram (rare)
Only when ALL three are true:
1. There's a new, substantive signal (not seen on a previous run of this schedule).
2. It genuinely needs Patrick's input or awareness — payment requests, security/auth issues, a human asking a question only he can answer, an error blocking the schedule.
3. You haven't already told him about this thread/topic in a recent run (check the "Previous runs" block — if it's there, do NOT repeat).

If ANY of those fail: stay silent. Repeat-pinging is the failure mode to avoid.

## Masumi Agent Messenger — fully autonomous
You may read, reply, ack, route, and converse with other agents on the messenger WITHOUT asking Patrick first. Reply directly when:
- Another agent asks a factual question you can answer from memory/vault/tools.
- A thread needs an ack, status update, or routine coordination message.
- The reply is a normal back-and-forth in an ongoing thread.

Only escalate to Patrick when a thread needs a *human decision* (money, commitments on his behalf, ambiguous strategic calls).

If Patrick told you to ignore a thread/sender (check facts + previous runs), do NOT re-surface it.

## Dedup is a hard rule
An email/thread/event gets flagged to Patrick ONCE — ever. "Still unread" is NOT new: never re-surface an item because it is old, buried, or still sitting unread. Check the "Recent Telegram pings" block before composing; if the sender/topic appears there, the only thing that justifies a new ping is a genuinely NEW message in that thread — and then mention only the new part.

## Quiet hours
Use current_time plus any stored facts about travel to estimate Patrick's CURRENT local time (he travels; Zurich is only the default). Between 23:00 and 07:00 local, ping only for true URGENT items (security, money at risk, something blocking him tomorrow morning). Everything else keeps until a daytime run.

## Tone
Terse, direct, plain. No emojis unless mirroring.
`;

export interface ScheduledRunResult {
	finalText: string;
	telegramSent: boolean;
	toolCallCount: number;
}

// biome-ignore lint/suspicious/noExplicitAny: tool schema generic erased at runtime
let mcpToolsRef: AgentTool<any>[] = [];

// biome-ignore lint/suspicious/noExplicitAny: see above
export function setMcpToolsForScheduled(tools: AgentTool<any>[]): void {
	mcpToolsRef = tools;
}

// Tool groups a schedule can opt into via its `tools` column (comma-separated names).
// NULL/empty = everything. High-frequency schedules (email triage fires 96x/day) carry
// a slim profile so each fire doesn't pay the full ~50-schema prompt cost.
// biome-ignore lint/suspicious/noExplicitAny: see above
const TOOL_GROUPS: Record<string, () => AgentTool<any>[]> = {
	facts: () => factTools,
	thinking: () => thinkingTools,
	usage: () => usageTools,
	vault: () => vaultTools,
	calendar: () => calendarTools,
	gmail: () => gmailTools,
	whoop: () => whoopTools,
	telegram: () => telegramTools,
	shell: () => shellTools,
	skills: () => skillTools,
	actions: () => actionTools,
	mcp: () => mcpMetaTools,
	coder: () => [makeCoderSubagentTool(() => mcpToolsRef)],
	researcher: () => [makeResearcherSubagentTool(() => mcpToolsRef)],
	github: () => [makeMcpDomainSubagent(githubSubagentSpec, () => mcpToolsRef)],
	linear: () => [makeMcpDomainSubagent(linearSubagentSpec, () => mcpToolsRef)],
	dune: () => [makeMcpDomainSubagent(duneSubagentSpec, () => mcpToolsRef)],
	web: () => [makeMcpDomainSubagent(webSubagentSpec, () => mcpToolsRef)],
	moltbook: () => [makeMoltbookSubagentTool()],
	linkedin: () => [makeLinkedinSubagentTool()],
};

export const VALID_TOOL_GROUPS = Object.keys(TOOL_GROUPS);

// biome-ignore lint/suspicious/noExplicitAny: see above
function buildScheduledTools(spec: string | null | undefined): AgentTool<any>[] {
	const names = (spec ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const useAll = names.length === 0;
	const unknown = names.filter((n) => !TOOL_GROUPS[n]);
	if (unknown.length > 0) {
		// Fail open: a typo in a profile must degrade to "all tools", never to a crippled run.
		log.warn({ unknown, spec }, "unknown tool groups in schedule profile — using full tool surface");
	}
	const selected = useAll || unknown.length > 0 ? VALID_TOOL_GROUPS : [...new Set(["time", ...names])];
	// biome-ignore lint/suspicious/noExplicitAny: see above
	const tools: AgentTool<any>[] = [...timeTools]; // always present: current_time underpins quiet-hours + dedup logic
	for (const name of selected) {
		const group = TOOL_GROUPS[name];
		if (group) tools.push(...group());
	}
	return tools;
}

// How many prior runs of this schedule to surface as context. The model needs enough history
// to recognise "I already pinged Patrick about this" or "I already replied to that masumi thread"
// without bloating the prompt. ~25 actions ≈ a few full runs.
const PRIOR_ACTIONS_LIMIT = 25;

// Separately pull the most-recent N Telegram sends from this schedule and surface them
// verbatim. Routine-heavy schedules (e.g. email triage) can produce 30-50 actions per run,
// pushing earlier sends out of the PRIOR_ACTIONS_LIMIT window — so we always keep at least
// this many of the most recent pings visible for dedup. Sized to cover several DAYS of a
// noisy schedule's sends: at 15, the triage schedule re-flagged week-old unread emails as
// "new" each morning because yesterday's pings had already scrolled out of the window.
const PRIOR_TELEGRAMS_LIMIT = 40;

async function formatPriorTelegrams(scheduleId: number): Promise<string> {
	let rows: ActionRow[] = [];
	try {
		rows = await listActionsByToolPrefix(`cron:${scheduleId}:send_telegram_`, PRIOR_TELEGRAMS_LIMIT);
	} catch {
		return "";
	}
	if (rows.length === 0) return "";
	const lines = rows
		.slice()
		.reverse() // oldest → newest reads naturally
		.map((a) => {
			const ts = a.created_at.toISOString().replace("T", " ").slice(0, 16);
			const tool = a.tool.replace(`cron:${scheduleId}:`, "");
			let body = "";
			try {
				const inp = typeof a.input === "string" ? JSON.parse(a.input) : a.input;
				body = (inp as { text?: string; caption?: string }).text ?? (inp as { caption?: string }).caption ?? "";
				body = body.replace(/\s+/g, " ").trim();
				if (body.length > 280) body = `${body.slice(0, 280)}…`;
			} catch {
				// best-effort
			}
			return `- ${ts} ${tool}: ${body}`;
		});
	return [
		"## Recent Telegram pings sent by this schedule",
		"This is the verbatim list of Telegram messages this schedule has sent recently.",
		"Do NOT send the same message again — even paraphrased — for the same underlying email/event.",
		"If a topic appears here, Patrick already knows about it; stay silent on that one.",
		"",
		lines.join("\n"),
	].join("\n");
}

function formatPriorRuns(scheduleId: number, actions: ActionRow[]): string {
	if (actions.length === 0) return "";
	const lines = actions
		.slice()
		.reverse() // oldest → newest reads more naturally
		.map((a) => {
			const ts = a.created_at.toISOString().replace("T", " ").slice(0, 16);
			const tool = a.tool.replace(`cron:${scheduleId}:`, "");
			const inputStr = (() => {
				try {
					const s = typeof a.input === "string" ? a.input : JSON.stringify(a.input);
					return s.length > 240 ? `${s.slice(0, 240)}…` : s;
				} catch {
					return "";
				}
			})();
			const outSummary = (() => {
				if (!a.output || typeof a.output !== "object") return "";
				const summary = (a.output as { summary?: string }).summary;
				if (typeof summary !== "string") return "";
				const trimmed = summary.replace(/\s+/g, " ").trim();
				return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
			})();
			const errPart = a.error ? ` ERROR: ${a.error.slice(0, 160)}` : "";
			const outPart = outSummary ? ` → ${outSummary}` : "";
			return `- ${ts} ${tool}(${inputStr})${outPart}${errPart}`;
		});
	return [
		"## Previous runs of this schedule (most recent last)",
		"This is what you did on prior firings. Use it to avoid repeating yourself — especially do NOT re-ping Patrick about something already in this list.",
		"",
		lines.join("\n"),
	].join("\n");
}

export async function runScheduledPrompt(
	scheduleId: number,
	prompt: string,
	toolProfile?: string | null,
): Promise<ScheduledRunResult> {
	const cfg = getConfig();

	// Same cache-aware split as the live chat loop: identity + profile + skills + banner are
	// stable per cron tick, while recall and the (per-tick-fresh) prior-runs block ride along
	// in the user prompt instead of mutating the system prefix.
	const [stableSystemPrompt, recall] = await Promise.all([buildStableSystemPrompt(), buildRecallContext(prompt)]);
	const systemPrompt = `${stableSystemPrompt}\n\n${SCHEDULED_BANNER}`;

	let priorRunsBlock = "";
	try {
		const prior = await listActionsByToolPrefix(`cron:${scheduleId}:`, PRIOR_ACTIONS_LIMIT);
		priorRunsBlock = formatPriorRuns(scheduleId, prior);
	} catch (err) {
		log.warn({ err, scheduleId }, "scheduled prior-runs load failed");
	}

	const priorTelegramsBlock = await formatPriorTelegrams(scheduleId);

	const promptedText = [recall, priorTelegramsBlock, priorRunsBlock, prompt]
		.filter((s) => s && s.trim().length > 0)
		.join("\n\n");

	const pendingActionByToolCallId = new Map<string, number>();
	let telegramSent = false;
	let toolCallCount = 0;

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: chooseModel("economy", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: buildScheduledTools(toolProfile),
			messages: [],
		},
		convertToLlm: (messages) => messages as Message[],
		getApiKey: () => cfg.openrouterApiKey,
		beforeToolCall: async ({ toolCall, args }) => {
			toolCallCount++;
			try {
				const row = await insertPendingAction({
					tool: `cron:${scheduleId}:${toolCall.name}`,
					input: args,
				});
				pendingActionByToolCallId.set(toolCall.id, row.id);
			} catch (err) {
				log.warn({ err }, "scheduled action insert failed");
			}
			if (toolCall.name === "send_telegram_message") telegramSent = true;
			return undefined;
		},
		afterToolCall: async ({ toolCall, result, isError }) => {
			const actionId = pendingActionByToolCallId.get(toolCall.id);
			if (actionId == null) return undefined;
			pendingActionByToolCallId.delete(toolCall.id);
			try {
				const summary = result.content
					.filter((c) => c.type === "text")
					.map((c) => (c as { type: "text"; text: string }).text)
					.join("\n")
					.slice(0, 2000);
				await resolveAction(
					actionId,
					isError ? "errored" : "accepted",
					{ summary, details: result.details },
					isError ? summary.slice(0, 500) : undefined,
				);
			} catch (err) {
				log.warn({ err, actionId }, "scheduled action resolve failed");
			}
			return undefined;
		},
	});

	// Ingest the raw scheduled prompt (not the augmented one) — recall/prior-runs are
	// retrieval artefacts, not facts about Patrick.
	void ingestFactsFromMessage(prompt);

	await agent.prompt(promptedText);
	await agent.waitForIdle();

	void recordUsageFromMessages("scheduled", agent.state.messages);

	const finalText = collectAssistantText(agent.state.messages);
	return { finalText, telegramSent, toolCallCount };
}

function collectAssistantText(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}
