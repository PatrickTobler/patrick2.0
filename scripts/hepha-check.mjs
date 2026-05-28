#!/usr/bin/env node
// Thin authenticated GET proxy for the Hepha read-only monitoring API.
//
// The bearer token is read from the HEPHA_MONITOR_TOKEN env var — it never
// appears in the agent's prompt, the schedules table, or run_shell args.
//
// Usage (path must start with /api/):
//   node scripts/hepha-check.mjs /api/tasks
//   node scripts/hepha-check.mjs "/api/tasks?status=failed"
//   node scripts/hepha-check.mjs "/api/tasks/<taskId>?events=true"
//
// Prints the raw JSON response body to stdout. Exit 0 on HTTP 2xx, else 1.

const BASE_URL = "https://coding-agent-mainnet.up.railway.app";

const token = process.env.HEPHA_MONITOR_TOKEN;
if (!token) {
	console.error("HEPHA_MONITOR_TOKEN is not set in the environment.");
	process.exit(1);
}

const path = process.argv[2];
if (!path || !path.startsWith("/api/")) {
	console.error('Usage: node scripts/hepha-check.mjs "/api/..."  (path must start with /api/)');
	process.exit(1);
}

try {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = await res.text();
	process.stdout.write(body);
	if (!res.ok) {
		console.error(`\nHTTP ${res.status} ${res.statusText}`);
		process.exit(1);
	}
} catch (err) {
	console.error(`Request failed: ${err?.message ?? err}`);
	process.exit(1);
}
