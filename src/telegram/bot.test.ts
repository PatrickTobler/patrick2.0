import { describe, expect, it } from "vitest";
import { isAllowedChat } from "./bot.ts";

describe("isAllowedChat", () => {
	it("accepts the owner chat", () => {
		expect(isAllowedChat(123, 123)).toBe(true);
	});
	it("rejects other chat ids", () => {
		expect(isAllowedChat(456, 123)).toBe(false);
	});
	it("rejects undefined", () => {
		expect(isAllowedChat(undefined, 123)).toBe(false);
	});
});
