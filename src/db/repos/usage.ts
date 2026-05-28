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
