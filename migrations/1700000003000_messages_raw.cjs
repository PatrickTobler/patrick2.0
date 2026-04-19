exports.up = (pgm) => {
	pgm.addColumns("messages", {
		raw_message: { type: "jsonb" },
	});
};

exports.down = (pgm) => {
	pgm.dropColumns("messages", ["raw_message"]);
};
