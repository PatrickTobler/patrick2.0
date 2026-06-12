exports.up = (pgm) => {
	pgm.addColumn("schedules", {
		// Comma-separated tool-group names (see TOOL_GROUPS in scheduled-runner.ts).
		// NULL = full tool surface (default). High-frequency schedules set a slim
		// profile so they don't pay the full schema cost on every fire.
		tools: { type: "text" },
	});
};

exports.down = (pgm) => {
	pgm.dropColumn("schedules", "tools");
};
