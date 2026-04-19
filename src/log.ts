import pino from "pino";

const PII_KEYS = new Set(["openrouterApiKey", "telegramBotToken", "databaseUrl", "apiKey", "token", "password"]);

export const log = pino({
	level: process.env.LOG_LEVEL || "info",
	formatters: {
		level: (label) => ({ level: label }),
	},
	redact: {
		paths: Array.from(PII_KEYS).flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
		censor: "[REDACTED]",
	},
});
