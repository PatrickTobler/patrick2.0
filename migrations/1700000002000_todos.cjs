exports.up = (pgm) => {
	pgm.createTable("todos", {
		id: { type: "bigserial", primaryKey: true },
		text: { type: "text", notNull: true },
		due_at: { type: "timestamptz" },
		completed_at: { type: "timestamptz" },
		snoozed_until: { type: "timestamptz" },
		created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
	});
	pgm.createIndex("todos", ["completed_at", "due_at"]);
	pgm.createIndex("todos", "due_at", { where: "completed_at IS NULL" });
};

exports.down = (pgm) => {
	pgm.dropTable("todos");
};
