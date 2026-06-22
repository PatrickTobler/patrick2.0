import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@mariozechner/pi-ai";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.ts";
import { type ConnectedMcpServer, connectMcpServer } from "./client.ts";
import { type McpServer, loadMcpServers } from "./config.ts";

const connectedServers: ConnectedMcpServer[] = [];

// One in-flight reconnect per server — concurrent failing calls share it instead of
// stampeding the endpoint with N parallel re-handshakes.
const reconnectInFlight = new Map<string, Promise<void>>();

function reconnectOnce(server: ConnectedMcpServer): Promise<void> {
	const existing = reconnectInFlight.get(server.name);
	if (existing) return existing;
	const p = server
		.reconnect()
		.catch((err) => {
			log.warn({ err, name: server.name }, "MCP reconnect failed");
			throw err;
		})
		.finally(() => reconnectInFlight.delete(server.name));
	reconnectInFlight.set(server.name, p);
	return p;
}

// A stale streamable-HTTP session (the GitHub Copilot MCP expires these server-side) surfaces
// as a transport/session error on callTool, not at connect time. These substrings catch it so
// we reconnect-and-retry instead of bubbling "invalid session" up to the model — which, on a
// weak model, improvises (asking the user to paste a fresh token) instead of just recovering.
const SESSION_ERROR_PATTERNS = ["session", "transport", "401", "unauthor", "closed", "econnreset", "fetch failed"];

export function isRecoverableError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return SESSION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

function sanitizeToolName(serverName: string, toolName: string): string {
	const combined = `mcp_${serverName}__${toolName}`;
	return combined.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

function mcpToAgentTool(server: ConnectedMcpServer, tool: McpTool): AgentTool {
	const safeName = sanitizeToolName(server.name, tool.name);
	const description = `[${server.name}] ${tool.description ?? tool.name}`;
	const schema = (tool.inputSchema ?? { type: "object" }) as unknown as TSchema;

	return {
		name: safeName,
		label: `${server.name}.${tool.name}`,
		description,
		parameters: schema,
		execute: async (_id, params) => {
			const args = (params as Record<string, unknown>) ?? {};
			const call = () => server.client.callTool({ name: tool.name, arguments: args });
			let result: Awaited<ReturnType<typeof call>>;
			try {
				result = await call();
			} catch (err) {
				if (!isRecoverableError(err)) throw err;
				// Stale session — reconnect and retry once before giving up.
				log.warn({ err, server: server.name, tool: tool.name }, "MCP call failed, reconnecting");
				await reconnectOnce(server);
				result = await call();
			}
			const blocks = (result.content ?? []) as Array<{ type: string; [k: string]: unknown }>;
			const content = blocks.map((block) => {
				if (block.type === "text") return { type: "text" as const, text: String(block.text) };
				if (block.type === "image") {
					return {
						type: "image" as const,
						data: String(block.data),
						mimeType: String(block.mimeType ?? "image/png"),
					};
				}
				return { type: "text" as const, text: JSON.stringify(block) };
			});
			return {
				content: content.length > 0 ? content : [{ type: "text", text: "(no content)" }],
				details: { server: server.name, tool: tool.name, isError: result.isError === true },
			};
		},
	};
}

export async function startMcpBridge(): Promise<AgentTool[]> {
	const servers: McpServer[] = loadMcpServers();
	const tools: AgentTool[] = [];
	const results = await Promise.allSettled(servers.map((s) => connectMcpServer(s)));
	for (const r of results) {
		if (r.status !== "fulfilled" || !r.value) continue;
		connectedServers.push(r.value);
		for (const t of r.value.tools) {
			tools.push(mcpToAgentTool(r.value, t));
		}
	}
	log.info({ servers: connectedServers.length, tools: tools.length }, "MCP bridge ready");
	return tools;
}

export async function stopMcpBridge(): Promise<void> {
	const closes = connectedServers.map((s) => s.close());
	connectedServers.length = 0;
	await Promise.allSettled(closes);
}

export function listConnectedServers(): { name: string; toolCount: number }[] {
	return connectedServers.map((s) => ({ name: s.name, toolCount: s.tools.length }));
}
