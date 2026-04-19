import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";

export interface StdioMcpConfig {
	type: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface HttpMcpConfig {
	type: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpConfig | HttpMcpConfig;

export interface McpServer {
	name: string;
	config: McpServerConfig;
}

const LOCAL_CONFIG_PATH = join(homedir(), ".claude.json");

/** Built-in cloud-friendly MCP servers — pure npx-installable, env-token-driven. */
function builtinCloudServers(): McpServer[] {
	const servers: McpServer[] = [];

	if (process.env.GITHUB_TOKEN) {
		servers.push({
			name: "github",
			config: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN },
			},
		});
	}

	if (process.env.RAILWAY_TOKEN) {
		servers.push({
			name: "railway",
			config: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@railway/mcp-server"],
				env: { RAILWAY_TOKEN: process.env.RAILWAY_TOKEN },
			},
		});
	}

	if (process.env.DUNE_API_KEY) {
		servers.push({
			name: "dune",
			config: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@duneanalytics/mcp"],
				env: { DUNE_API_KEY: process.env.DUNE_API_KEY },
			},
		});
	}

	return servers;
}

function loadFromLocalConfig(): McpServer[] {
	if (!existsSync(LOCAL_CONFIG_PATH)) {
		log.info({ path: LOCAL_CONFIG_PATH }, "no local MCP config found");
		return [];
	}
	let raw: string;
	try {
		raw = readFileSync(LOCAL_CONFIG_PATH, "utf-8");
	} catch (err) {
		log.warn({ err, path: LOCAL_CONFIG_PATH }, "MCP config unreadable");
		return [];
	}
	let parsed: { mcpServers?: Record<string, McpServerConfig> };
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		log.warn({ err, path: LOCAL_CONFIG_PATH }, "MCP config not valid JSON");
		return [];
	}
	const map = parsed.mcpServers ?? {};
	const servers: McpServer[] = [];
	for (const [name, config] of Object.entries(map)) {
		if (config.type === "stdio" && config.command) {
			servers.push({ name, config });
			continue;
		}
		if ((config.type === "http" || config.type === "sse") && "url" in config && config.url) {
			servers.push({ name, config });
			continue;
		}
		log.warn({ name }, "MCP server config skipped (unsupported)");
	}
	return servers;
}

export function loadMcpServers(): McpServer[] {
	// Production: only built-in cloud-friendly servers.
	// Development: also pull in everything from ~/.claude.json so local dev has full toolset.
	const useLocal = process.env.NODE_ENV !== "production";
	const servers = useLocal ? [...loadFromLocalConfig()] : [];

	const builtins = builtinCloudServers();
	const seen = new Set(servers.map((s) => s.name));
	for (const b of builtins) {
		if (!seen.has(b.name)) servers.push(b);
	}

	log.info(
		{ count: servers.length, source: useLocal ? "local+builtin" : "builtin", names: servers.map((s) => s.name) },
		"MCP servers configured",
	);
	return servers;
}
