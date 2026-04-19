import "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

export type ModelClass = "reasoning" | "fast" | "cheap";

interface ModelEntry {
	id: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const MODELS: Record<ModelClass, ModelEntry[]> = {
	reasoning: [
		{ id: "anthropic/claude-opus-4", contextWindow: 200_000, maxTokens: 8192, cost: { input: 15, output: 75 } },
		{ id: "anthropic/claude-sonnet-4", contextWindow: 200_000, maxTokens: 8192, cost: { input: 3, output: 15 } },
	],
	fast: [
		{ id: "anthropic/claude-haiku-4.5", contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 5 } },
		{ id: "openai/gpt-4o-mini", contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0.15, output: 0.6 } },
	],
	cheap: [
		{ id: "google/gemini-2.5-flash", contextWindow: 1_000_000, maxTokens: 8192, cost: { input: 0.075, output: 0.3 } },
		{ id: "openai/gpt-4o-mini", contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0.15, output: 0.6 } },
	],
};

function entryToModel(entry: ModelEntry, apiKey: string): Model<"openai-completions"> {
	return {
		id: entry.id,
		name: entry.id,
		api: "openai-completions",
		provider: "openai" as Model<"openai-completions">["provider"],
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: entry.cost.input, output: entry.cost.output, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"HTTP-Referer": "https://patrick2.0",
			"X-Title": "patrick2.0",
		},
	};
}

export interface ChooseModelOptions {
	preferIndex?: number;
}

export function chooseModel(
	cls: ModelClass,
	apiKey: string,
	opts: ChooseModelOptions = {},
): Model<"openai-completions"> {
	const list = MODELS[cls];
	const idx = Math.min(opts.preferIndex ?? 0, list.length - 1);
	const entry = list[idx];
	if (!entry) throw new Error(`No model for class ${cls} at index ${idx}`);
	return entryToModel(entry, apiKey);
}

export function listModels(cls: ModelClass): readonly ModelEntry[] {
	return MODELS[cls];
}
