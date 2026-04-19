import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { listConnectedServers } from "../../mcp/bridge.ts";

const ListSchema = Type.Object({});

export const listMcpTool: AgentTool<typeof ListSchema> = {
	name: "list_mcp_servers",
	label: "List MCP servers",
	description:
		"List the MCP servers currently connected and how many tools each exposes. Use when Patrick asks 'what integrations do you have' or 'are you connected to X'.",
	parameters: ListSchema,
	execute: async () => {
		const servers = listConnectedServers();
		if (servers.length === 0) {
			return { content: [{ type: "text", text: "No MCP servers connected." }], details: { servers: [] } };
		}
		const lines = servers.map((s) => `- **${s.name}** — ${s.toolCount} tools`);
		const total = servers.reduce((sum, s) => sum + s.toolCount, 0);
		return {
			content: [{ type: "text", text: `${servers.length} MCP servers, ${total} tools:\n${lines.join("\n")}` }],
			details: { servers },
		};
	},
};

// biome-ignore lint/suspicious/noExplicitAny: pi's AgentTool[] expects any-typed schema
export const mcpMetaTools: AgentTool<any>[] = [listMcpTool];
