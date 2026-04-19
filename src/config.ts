import "dotenv/config";

function required(name: string): string {
	const value = process.env[name];
	if (!value || value.trim() === "") {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function optional(name: string, fallback = ""): string {
	return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (Number.isNaN(parsed)) {
		throw new Error(`Env var ${name} must be a number, got: ${raw}`);
	}
	return parsed;
}

export interface Config {
	nodeEnv: "development" | "production" | "test";
	logLevel: string;
	openrouterApiKey: string;
	telegramBotToken: string;
	telegramOwnerChatId: number;
	telegramWebhookUrl: string;
	databaseUrl: string;
}

let cached: Config | null = null;

export function getConfig(): Config {
	if (cached) return cached;
	cached = {
		nodeEnv: optional("NODE_ENV", "development") as Config["nodeEnv"],
		logLevel: optional("LOG_LEVEL", "info"),
		openrouterApiKey: required("OPENROUTER_API_KEY"),
		telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
		telegramOwnerChatId: num("TELEGRAM_OWNER_CHAT_ID", 0),
		telegramWebhookUrl: optional("TELEGRAM_WEBHOOK_URL"),
		databaseUrl: required("DATABASE_URL"),
	};
	if (cached.telegramOwnerChatId === 0) {
		throw new Error("TELEGRAM_OWNER_CHAT_ID must be set to your Telegram chat ID");
	}
	return cached;
}

export function resetConfigForTests(): void {
	cached = null;
}
