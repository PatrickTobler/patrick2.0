import { spawn } from "node:child_process";
import { createServer } from "node:http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

const SCOPES = [
	"https://www.googleapis.com/auth/calendar",
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
	"https://www.googleapis.com/auth/userinfo.email",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env");
	process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

const server = createServer(async (req, res) => {
	if (!req.url?.startsWith("/oauth/callback")) {
		res.writeHead(404).end();
		return;
	}
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const code = url.searchParams.get("code");
	const error = url.searchParams.get("error");
	if (error) {
		res.writeHead(400, { "content-type": "text/html" }).end(`<h1>Error: ${error}</h1>`);
		console.error("OAuth error:", error);
		process.exit(1);
	}
	if (!code) {
		res.writeHead(400).end("missing code");
		return;
	}

	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: REDIRECT_URI,
			grant_type: "authorization_code",
		}),
	});
	const tokens = (await tokenRes.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		token_type?: string;
		error?: string;
		error_description?: string;
	};

	if (tokens.error) {
		res
			.writeHead(400, { "content-type": "text/html" })
			.end(`<h1>Token exchange failed</h1><pre>${tokens.error}: ${tokens.error_description}</pre>`);
		console.error("Token exchange failed:", tokens);
		process.exit(1);
	}

	res
		.writeHead(200, { "content-type": "text/html" })
		.end("<h1>Done.</h1><p>Refresh token printed in your terminal. You can close this tab.</p>");

	console.log("\n=== SUCCESS ===");
	console.log("Scopes granted:", tokens.scope);
	console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
	console.log("\nPaste the line above into the chat.\n");
	setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => {
	console.log(`Listening on http://localhost:${PORT}`);
	console.log("Opening browser for Google consent...");
	console.log("If browser does not open, visit:\n", authUrl.toString());
	spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
});
