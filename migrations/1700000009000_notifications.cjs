exports.up = (pgm) => {
	// Ledger of everything Chadrick has notified Patrick about. Dedup is enforced HERE,
	// in code, instead of asking the model to remember its own pings.
	pgm.createTable("notified_items", {
		id: { type: "bigserial", primaryKey: true },
		item_key: { type: "text", notNull: true },
		urgency: { type: "text", notNull: true },
		text: { type: "text", notNull: true },
		source: { type: "text" },
		embedding: { type: "vector(1536)" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("notified_items", ["item_key", "created_at"]);
	pgm.createIndex("notified_items", "created_at");

	// Non-urgent notifications raised during quiet hours wait here for the morning batch.
	pgm.createTable("queued_notifications", {
		id: { type: "bigserial", primaryKey: true },
		text: { type: "text", notNull: true },
		urgency: { type: "text", notNull: true },
		deliver_after: { type: "timestamptz", notNull: true },
		delivered_at: { type: "timestamptz" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("queued_notifications", "deliver_after");

	// One-shot schedules disable themselves in code after a successful fire —
	// "pause yourself after sending" prompts don't work (scheduled runs have no pause tool).
	pgm.addColumn("schedules", {
		one_shot: { type: "boolean", notNull: true, default: false },
	});
	// Per-schedule model class (see ModelClass in llm/router.ts). NULL = economy.
	pgm.addColumn("schedules", {
		model_class: { type: "text" },
	});
};

exports.down = (pgm) => {
	pgm.dropColumn("schedules", "model_class");
	pgm.dropColumn("schedules", "one_shot");
	pgm.dropTable("queued_notifications");
	pgm.dropTable("notified_items");
};
