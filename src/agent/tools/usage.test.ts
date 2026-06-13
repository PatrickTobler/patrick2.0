import { describe, expect, it } from "vitest";
import type { UsageSummary } from "../../db/repos/usage.ts";
import { formatUsageSummary } from "./usage.ts";

const empty: UsageSummary = {
	totalTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalCostUsd: 0,
	byModel: [],
	bySource: [],
};

describe("formatUsageSummary", () => {
	it("reports a clean zero-spend line", () => {
		const out = formatUsageSummary(empty, 24);
		expect(out).toContain("none recorded");
		expect(out).toContain("last 24h");
	});

	it("formats totals, models and sources", () => {
		const s: UsageSummary = {
			totalTokens: 1_250_000,
			inputTokens: 1_000_000,
			outputTokens: 250_000,
			totalCostUsd: 0.84,
			byModel: [
				{ key: "xiaomi/mimo-v2.5-pro", totalTokens: 900_000, costUsd: 0.71 },
				{ key: "deepseek/deepseek-v4-flash", totalTokens: 350_000, costUsd: 0.13 },
			],
			bySource: [{ key: "orchestrator", totalTokens: 1_250_000, costUsd: 0.84 }],
		};
		const out = formatUsageSummary(s, 24);
		expect(out).toContain("1.25M tokens");
		expect(out).toContain("$0.84");
		expect(out).toContain("xiaomi/mimo-v2.5-pro");
		expect(out).toContain("deepseek/deepseek-v4-flash");
		expect(out).toContain("orchestrator");
	});

	it("shows sub-cent costs as <$0.01 and a custom window", () => {
		const s: UsageSummary = {
			...empty,
			totalTokens: 5000,
			inputTokens: 4000,
			outputTokens: 1000,
			totalCostUsd: 0.003,
			byModel: [{ key: "deepseek/deepseek-v4-flash", totalTokens: 5000, costUsd: 0.003 }],
		};
		const out = formatUsageSummary(s, 48);
		expect(out).toContain("last 48h");
		expect(out).toContain("<$0.01");
		expect(out).toContain("5.0k");
	});
});

import { formatAnomalies } from "./usage.ts";

describe("formatAnomalies", () => {
	// Models the zombie-spend case this detector exists for: a deleted subagent that
	// kept costing money with no prior-7-day baseline (the Moltbook ghost-cron incident).
	it("flags sources far above baseline and new/resurrected sources", () => {
		const out = formatAnomalies(
			[
				{ source: "subagent:deleted-campaign", windowCostUsd: 4.8, baselineDailyCostUsd: 0 },
				{ source: "scheduled", windowCostUsd: 0.9, baselineDailyCostUsd: 0.5 },
				{ source: "facts", windowCostUsd: 0.02, baselineDailyCostUsd: 0.02 },
			],
			24,
		);
		expect(out).toContain("subagent:deleted-campaign");
		expect(out).toContain("NO spend in the prior 7 days");
		expect(out).toContain("1.8x");
		expect(out).not.toContain("facts");
	});

	it("reports normal when nothing crosses thresholds", () => {
		const out = formatAnomalies([{ source: "scheduled", windowCostUsd: 0.5, baselineDailyCostUsd: 0.45 }], 24);
		expect(out).toContain("none");
	});
});
