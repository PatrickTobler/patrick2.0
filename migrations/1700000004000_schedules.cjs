exports.up = (pgm) => {
	pgm.createTable("schedules", {
		id: { type: "bigserial", primaryKey: true },
		cron: { type: "text", notNull: true },
		timezone: { type: "text", notNull: true, default: "Europe/Zurich" },
		prompt: { type: "text", notNull: true },
		enabled: { type: "boolean", notNull: true, default: true },
		last_fired_at: { type: "timestamptz" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("schedules", "enabled");
};

exports.down = (pgm) => {
	pgm.dropTable("schedules");
};
