/* eslint-disable @typescript-eslint/no-var-requires */
exports.up = (pgm) => {
	pgm.createExtension("vector", { ifNotExists: true });

	pgm.createTable("messages", {
		id: { type: "bigserial", primaryKey: true },
		chat_id: { type: "bigint", notNull: true },
		role: { type: "text", notNull: true, check: "role in ('user','assistant','tool')" },
		content: { type: "text", notNull: true },
		tool_calls: { type: "jsonb" },
		tool_call_id: { type: "text" },
		token_count: { type: "integer" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("messages", ["chat_id", "created_at"]);

	pgm.createTable("memory_facts", {
		id: { type: "bigserial", primaryKey: true },
		text: { type: "text", notNull: true },
		embedding: { type: "vector(1536)" },
		source: { type: "text" },
		confidence: { type: "real", notNull: true, default: 1.0 },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
		updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.sql("CREATE INDEX memory_facts_embedding_idx ON memory_facts USING ivfflat (embedding vector_cosine_ops)");

	pgm.createTable("memory_thinking", {
		id: { type: "bigserial", primaryKey: true },
		text: { type: "text", notNull: true },
		topics: { type: "text[]" },
		embedding: { type: "vector(1536)" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.sql("CREATE INDEX memory_thinking_embedding_idx ON memory_thinking USING ivfflat (embedding vector_cosine_ops)");
	pgm.createIndex("memory_thinking", ["created_at"]);

	pgm.createTable("memory_actions", {
		id: { type: "bigserial", primaryKey: true },
		tool: { type: "text", notNull: true },
		input: { type: "jsonb", notNull: true },
		output: { type: "jsonb" },
		outcome: { type: "text", check: "outcome in ('pending','accepted','rejected','edited','errored')" },
		error: { type: "text" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
		resolved_at: { type: "timestamptz" },
	});
	pgm.createIndex("memory_actions", ["outcome", "created_at"]);

	pgm.createTable("notes", {
		id: { type: "bigserial", primaryKey: true },
		title: { type: "text" },
		body: { type: "text", notNull: true },
		tags: { type: "text[]" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});

	pgm.createTable("kv", {
		key: { type: "text", primaryKey: true },
		value: { type: "jsonb", notNull: true },
		updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
};

exports.down = (pgm) => {
	pgm.dropTable("kv");
	pgm.dropTable("notes");
	pgm.dropTable("memory_actions");
	pgm.dropTable("memory_thinking");
	pgm.dropTable("memory_facts");
	pgm.dropTable("messages");
	pgm.dropExtension("vector", { ifExists: true });
};
