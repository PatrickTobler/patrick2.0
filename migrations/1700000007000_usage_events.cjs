exports.up = (pgm) => {
	pgm.createTable("usage_events", {
		id: { type: "bigserial", primaryKey: true },
		source: { type: "text", notNull: true },
		model: { type: "text", notNull: true },
		input_tokens: { type: "integer", notNull: true, default: 0 },
		output_tokens: { type: "integer", notNull: true, default: 0 },
		total_tokens: { type: "integer", notNull: true, default: 0 },
		cost_usd: { type: "numeric", notNull: true, default: 0 },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("usage_events", "created_at");
};

exports.down = (pgm) => {
	pgm.dropTable("usage_events");
};
