import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.ts";
import type { McpServer } from "./config.ts";

export interface ConnectedMcpServer {
	name: string;
	client: Client;
	tools: McpTool[];
	close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;

export async function connectMcpServer(server: McpServer): Promise<ConnectedMcpServer | null> {
	const client = new Client({ name: "patrick2.0", version: "0.0.0" }, { capabilities: {} });

	try {
		let transport: Transport;
		if (server.config.type === "stdio") {
			transport = new StdioClientTransport({
				command: server.config.command,
				args: server.config.args,
				env: { ...process.env, ...server.config.env } as Record<string, string>,
			}) as Transport;
		} else {
			transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
				requestInit: { headers: server.config.headers ?? {} },
			}) as Transport;
		}
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${server.name} connect`);

		const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${server.name} listTools`);
		log.info({ server: server.name, tools: listed.tools.length }, "MCP server connected");
		return {
			name: server.name,
			client,
			tools: listed.tools,
			close: async () => {
				try {
					await client.close();
				} catch (err) {
					log.warn({ err, name: server.name }, "MCP close failed");
				}
			},
		};
	} catch (err) {
		log.warn({ err, name: server.name }, "MCP server failed to connect");
		try {
			await client.close();
		} catch {}
		return null;
	}
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}
