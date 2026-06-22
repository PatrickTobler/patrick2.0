import { describe, expect, it } from "vitest";
import { isRecoverableError } from "./bridge.ts";

describe("isRecoverableError", () => {
	it("matches stale-session / transport / auth failures that warrant a reconnect", () => {
		const recoverable = [
			new Error("Mcp-Session-Id is invalid or expired"),
			new Error("HTTP 401 Unauthorized"),
			new Error("transport closed unexpectedly"),
			new Error("fetch failed"),
			new Error("read ECONNRESET"),
			"invalid session", // non-Error throw
		];
		for (const e of recoverable) expect(isRecoverableError(e)).toBe(true);
	});

	it("does not reconnect on ordinary tool errors (bad args, not found)", () => {
		const fatal = [
			new Error("Repository not found"),
			new Error("validation failed: missing required field 'owner'"),
			new Error("rate limit exceeded"),
		];
		for (const e of fatal) expect(isRecoverableError(e)).toBe(false);
	});
});
