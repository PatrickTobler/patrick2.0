import { query } from "../pool.ts";

export interface UsageEntry {
	source: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export interface UsageBreakdown {
	key: string;
	totalTokens: number;
	costUsd: number;
}

export interface UsageSummary {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	totalCostUsd: number;
	byModel: UsageBreakdown[];
	bySource: UsageBreakdown[];
}

export async function recordUsage(entries: UsageEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const values: string[] = [];
	const params: unknown[] = [];
	let i = 1;
	for (const e of entries) {
		values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
		params.push(e.source, e.model, e.inputTokens, e.outputTokens, e.totalTokens, e.costUsd);
	}
	await query(
		`insert into usage_events (source, model, input_tokens, output_tokens, total_tokens, cost_usd)
		 values ${values.join(", ")}`,
		params,
	);
}

interface TotalsRow {
	input: string | null;
	output: string | null;
	total: string | null;
	cost: string | null;
}

interface GroupRow {
	key: string;
	tokens: string | null;
	cost: string | null;
}

export interface SourceBaseline {
	source: string;
	windowCostUsd: number;
	baselineDailyCostUsd: number;
}

/**
 * Per-source spend in the current window vs the daily average over the prior 7 days
 * (window excluded). Lets the token report flag anomalies deterministically instead
 * of asking the model to do cross-call arithmetic.
 */
export async function compareUsageToBaseline(windowHours: number): Promise<SourceBaseline[]> {
	const res = await query<{ source: string; window_cost: string | null; baseline_daily: string | null }>(
		`with win as (
		   select source, sum(cost_usd) as cost
		   from usage_events
		   where created_at >= now() - ($1 || ' hours')::interval
		   group by source
		 ), base as (
		   select source, sum(cost_usd) / 7.0 as daily
		   from usage_events
		   where created_at >= now() - ($1 || ' hours')::interval - interval '7 days'
		     and created_at <  now() - ($1 || ' hours')::interval
		   group by source
		 )
		 select coalesce(w.source, b.source) as source,
		        coalesce(w.cost, 0) as window_cost,
		        coalesce(b.daily, 0) as baseline_daily
		 from win w full outer join base b on w.source = b.source
		 order by coalesce(w.cost, 0) desc`,
		[windowHours],
	);
	return res.rows.map((r) => ({
		source: r.source,
		windowCostUsd: Number(r.window_cost ?? 0),
		baselineDailyCostUsd: Number(r.baseline_daily ?? 0),
	}));
}

export async function summarizeUsageSince(since: Date): Promise<UsageSummary> {
	const [totals, byModel, bySource] = await Promise.all([
		query<TotalsRow>(
			`select coalesce(sum(input_tokens), 0) as input,
			        coalesce(sum(output_tokens), 0) as output,
			        coalesce(sum(total_tokens), 0) as total,
			        coalesce(sum(cost_usd), 0) as cost
			 from usage_events where created_at >= $1`,
			[since],
		),
		query<GroupRow>(
			`select model as key,
			        coalesce(sum(total_tokens), 0) as tokens,
			        coalesce(sum(cost_usd), 0) as cost
			 from usage_events where created_at >= $1
			 group by model order by cost desc`,
			[since],
		),
		query<GroupRow>(
			`select source as key,
			        coalesce(sum(total_tokens), 0) as tokens,
			        coalesce(sum(cost_usd), 0) as cost
			 from usage_events where created_at >= $1
			 group by source order by cost desc`,
			[since],
		),
	]);

	const t = totals.rows[0];
	const toBreakdown = (rows: GroupRow[]): UsageBreakdown[] =>
		rows.map((r) => ({ key: r.key, totalTokens: Number(r.tokens ?? 0), costUsd: Number(r.cost ?? 0) }));

	return {
		totalTokens: Number(t?.total ?? 0),
		inputTokens: Number(t?.input ?? 0),
		outputTokens: Number(t?.output ?? 0),
		totalCostUsd: Number(t?.cost ?? 0),
		byModel: toBreakdown(byModel.rows),
		bySource: toBreakdown(bySource.rows),
	};
}
