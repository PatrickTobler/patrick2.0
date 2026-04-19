import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@mariozechner/pi-ai";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.ts";
import { type ConnectedMcpServer, connectMcpServer } from "./client.ts";
import { type McpServer, loadMcpServers } from "./config.ts";

const connectedServers: ConnectedMcpServer[] = [];

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
			const result = await server.client.callTool({
				name: tool.name,
				arguments: (params as Record<string, unknown>) ?? {},
			});
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
