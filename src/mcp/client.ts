import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.ts";
import type { McpServer } from "./config.ts";

export interface ConnectedMcpServer {
	name: string;
	/** Live client. Reassigned by reconnect() — tool wrappers must read this at call time. */
	client: Client;
	tools: McpTool[];
	/** Re-establish a fresh transport + session in place (e.g. after a server-side session expiry). */
	reconnect: () => Promise<void>;
	close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;

/** Build a transport + connected client and list its tools. Throws on failure. */
async function openClient(server: McpServer): Promise<{ client: Client; tools: McpTool[] }> {
	const client = new Client({ name: "patrick2.0", version: "0.0.0" }, { capabilities: {} });
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
	return { client, tools: listed.tools };
}

export async function connectMcpServer(server: McpServer): Promise<ConnectedMcpServer | null> {
	try {
		const { client, tools } = await openClient(server);
		log.info({ server: server.name, tools: tools.length }, "MCP server connected");
		const connected: ConnectedMcpServer = {
			name: server.name,
			client,
			tools,
			reconnect: async () => {
				// Drop the dead client, then stand up a fresh session. Best-effort close —
				// the old transport is usually already broken, which is why we're here.
				try {
					await connected.client.close();
				} catch {}
				const fresh = await openClient(server);
				connected.client = fresh.client;
				connected.tools = fresh.tools;
				log.info({ server: server.name, tools: fresh.tools.length }, "MCP server reconnected");
			},
			close: async () => {
				try {
					await connected.client.close();
				} catch (err) {
					log.warn({ err, name: server.name }, "MCP close failed");
				}
			},
		};
		return connected;
	} catch (err) {
		log.warn({ err, name: server.name }, "MCP server failed to connect");
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
