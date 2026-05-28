import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type UsageEntry, recordUsage } from "../db/repos/usage.ts";
import { log } from "../log.ts";

interface AssistantUsage {
	role: string;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
}

/**
 * Best-effort: sum the token usage of every assistant message in a finished run, grouped by model,
 * and persist it. Never throws — usage tracking must not break an agent turn.
 */
export async function recordUsageFromMessages(source: string, messages: AgentMessage[]): Promise<void> {
	try {
		const byModel = new Map<string, UsageEntry>();
		for (const raw of messages) {
			const m = raw as unknown as AssistantUsage;
			if (m.role !== "assistant" || !m.usage) continue;
			const model = m.model ?? "unknown";
			const entry = byModel.get(model) ?? {
				source,
				model,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costUsd: 0,
			};
			entry.inputTokens += m.usage.input ?? 0;
			entry.outputTokens += m.usage.output ?? 0;
			entry.totalTokens += m.usage.totalTokens ?? 0;
			entry.costUsd += m.usage.cost?.total ?? 0;
			byModel.set(model, entry);
		}
		const entries = [...byModel.values()].filter((e) => e.totalTokens > 0 || e.costUsd > 0);
		await recordUsage(entries);
	} catch (err) {
		log.warn({ err, source }, "usage recording failed");
	}
}
