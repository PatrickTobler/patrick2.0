import { describe, expect, it } from "vitest";
import { chooseModel, listModels } from "./router.ts";

describe("chooseModel", () => {
	it("returns the configured reasoning model", () => {
		const m = chooseModel("reasoning", "sk-test");
		expect(m.id).toBe("anthropic/claude-opus-4");
		expect(m.api).toBe("openai-completions");
		expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("returns the configured fast model", () => {
		const m = chooseModel("fast", "sk-test");
		expect(m.id).toBe("anthropic/claude-haiku-4.5");
	});

	it("returns the configured cheap model", () => {
		const m = chooseModel("cheap", "sk-test");
		expect(m.id).toBe("google/gemini-2.5-flash");
	});

	it("supports fallback via preferIndex", () => {
		const m = chooseModel("reasoning", "sk-test", { preferIndex: 1 });
		expect(m.id).toBe("anthropic/claude-sonnet-4");
	});

	it("clamps preferIndex to the last available model", () => {
		const m = chooseModel("reasoning", "sk-test", { preferIndex: 99 });
		const last = listModels("reasoning").at(-1);
		expect(m.id).toBe(last?.id);
	});

	it("includes OpenRouter auth headers", () => {
		const m = chooseModel("fast", "sk-or-test-123");
		expect(m.headers?.Authorization).toBe("Bearer sk-or-test-123");
		expect(m.headers?.["X-Title"]).toBe("patrick2.0");
	});
});
