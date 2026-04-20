import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { log } from "../../log.ts";

const exec = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;

const Schema = Type.Object({
	command: Type.String({
		description:
			"The binary to run (e.g. 'masumi-agent-messenger', 'gtm', 'bash'). No shell interpolation — arguments are passed as a list, not a command string.",
		minLength: 1,
		maxLength: 100,
	}),
	args: Type.Array(Type.String({ maxLength: 4000 }), {
		description:
			"Arguments as a list. Quote handling is done for you — do not add outer quotes. E.g. ['--json', 'thread', 'reply', '--id', '42', '--body', 'hello'].",
		maxItems: 50,
	}),
	timeout_ms: Type.Optional(
		Type.Number({
			description: "Max runtime in milliseconds. Default 30000, max 120000.",
			minimum: 100,
			maximum: MAX_TIMEOUT_MS,
			default: DEFAULT_TIMEOUT_MS,
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Extra env vars for this call. Merged on top of the container's env (your env vars win).",
		}),
	),
});

export const runShellTool: AgentTool<typeof Schema> = {
	name: "run_shell",
	label: "Run a shell command",
	description:
		"Execute a CLI binary with arguments. No shell interpolation (args is a list, not a string). Use to invoke CLIs you learned about from skills: masumi-agent-messenger, gtm, wise_query.sh, etc. Every call is logged to action history. Default timeout 30s, max 120s. Output capped at ~200 KB.",
	parameters: Schema,
	execute: async (_id, params: Static<typeof Schema>) => {
		const timeout = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		try {
			const { stdout, stderr } = await exec(params.command, params.args, {
				timeout,
				maxBuffer: MAX_OUTPUT_BYTES,
				env: { ...process.env, ...(params.env ?? {}) },
			});
			const truncatedStdout =
				stdout.length > MAX_OUTPUT_BYTES ? `${stdout.slice(0, MAX_OUTPUT_BYTES)}…(truncated)` : stdout;
			const text = `$ ${params.command} ${params.args.join(" ")}\n\n${truncatedStdout}${stderr ? `\n--- stderr ---\n${stderr.slice(0, 2000)}` : ""}`;
			return { content: [{ type: "text", text }], details: { exitCode: 0, stdoutBytes: stdout.length } };
		} catch (err) {
			const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
			log.warn(
				{ command: params.command, code: e.code, signal: (e as { signal?: string }).signal },
				"run_shell failed",
			);
			const stderrText = e.stderr?.slice(0, 4000) ?? "";
			const stdoutText = e.stdout?.slice(0, 4000) ?? "";
			const text = `$ ${params.command} ${params.args.join(" ")}\n\nexit: ${e.code ?? "?"}\n${stdoutText}${stderrText ? `\n--- stderr ---\n${stderrText}` : ""}${e.message ? `\n--- error ---\n${e.message}` : ""}`;
			return { content: [{ type: "text", text }], details: { exitCode: e.code ?? null, error: e.message } };
		}
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const shellTools: AgentTool<any>[] = [runShellTool];
