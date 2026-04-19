exports.up = (pgm) => {
	pgm.addColumns("messages", {
		embedding: { type: "vector(1536)" },
	});
	pgm.sql(
		"CREATE INDEX messages_embedding_idx ON messages USING ivfflat (embedding vector_cosine_ops)",
	);
};

exports.down = (pgm) => {
	pgm.sql("DROP INDEX IF EXISTS messages_embedding_idx");
	pgm.dropColumns("messages", ["embedding"]);
};
