import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getConfig } from "../config.ts";
import { type ActionRow, insertPendingAction, listActionsByToolPrefix, resolveAction } from "../db/repos/actions.ts";
import { chooseModel } from "../llm/router.ts";
import { log } from "../log.ts";
import { ingestFactsFromMessage } from "./facts.ts";
import { buildRecallContext, buildStableSystemPrompt } from "./memory-context.ts";
import { makeCoderSubagentTool } from "./subagents/coder.ts";
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
// Native todos disabled — Patrick uses Linear (via MCP) instead.
import { vaultTools } from "./tools/vault.ts";
import { whoopTools } from "./tools/whoop.ts";

const SCHEDULED_BANNER = `
You are running on a schedule — Patrick did NOT just message you. This is autonomous time.

## Default behavior: silence
- Do NOT send_telegram_message to confirm you ran. Patrick audits via query_actions.
- The "user" message below is the scheduled prompt — instructions, not a conversation.

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

// How many prior runs of this schedule to surface as context. The model needs enough history
// to recognise "I already pinged Patrick about this" or "I already replied to that masumi thread"
// without bloating the prompt. ~25 actions ≈ a few full runs.
const PRIOR_ACTIONS_LIMIT = 25;

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

export async function runScheduledPrompt(scheduleId: number, prompt: string): Promise<ScheduledRunResult> {
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

	const promptedText = [recall, priorRunsBlock, prompt].filter((s) => s && s.trim().length > 0).join("\n\n");

	const pendingActionByToolCallId = new Map<string, number>();
	let telegramSent = false;
	let toolCallCount = 0;

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: chooseModel("fast", cfg.openrouterApiKey),
			thinkingLevel: "off",
			tools: [
				...factTools,
				...thinkingTools,
				...timeTools,
				...vaultTools,
				...calendarTools,
				...gmailTools,
				...whoopTools,
				...telegramTools,
				...shellTools,
				...skillTools,
				...actionTools,
				...mcpMetaTools,
				// Same subagent pattern as main agent — keeps scheduled runs light.
				makeCoderSubagentTool(() => mcpToolsRef),
				makeResearcherSubagentTool(() => mcpToolsRef),
				makeMcpDomainSubagent(githubSubagentSpec, () => mcpToolsRef),
				makeMcpDomainSubagent(linearSubagentSpec, () => mcpToolsRef),
				makeMcpDomainSubagent(duneSubagentSpec, () => mcpToolsRef),
				makeMcpDomainSubagent(webSubagentSpec, () => mcpToolsRef),
				makeMoltbookSubagentTool(),
			],
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
