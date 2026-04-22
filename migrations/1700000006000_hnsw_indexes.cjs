/**
 * Switch IVFFlat → HNSW for all vector embedding indexes.
 *
 * Why: HNSW gives much better recall at scale (10K+ vectors) with comparable
 * query latency. IVFFlat needs careful tuning of `lists` parameter and degrades
 * recall when the table grows beyond what the index was trained for.
 *
 * Defaults: m=16, ef_construction=64 — proven defaults from pgvector docs.
 * At our current scale (<1K vectors) build time is sub-second.
 */
exports.up = (pgm) => {
	pgm.sql("DROP INDEX IF EXISTS memory_facts_embedding_idx");
	pgm.sql(
		"CREATE INDEX memory_facts_embedding_idx ON memory_facts USING hnsw (embedding vector_cosine_ops)",
	);

	pgm.sql("DROP INDEX IF EXISTS memory_thinking_embedding_idx");
	pgm.sql(
		"CREATE INDEX memory_thinking_embedding_idx ON memory_thinking USING hnsw (embedding vector_cosine_ops)",
	);

	pgm.sql("DROP INDEX IF EXISTS messages_embedding_idx");
	pgm.sql("CREATE INDEX messages_embedding_idx ON messages USING hnsw (embedding vector_cosine_ops)");
};

exports.down = (pgm) => {
	pgm.sql("DROP INDEX IF EXISTS memory_facts_embedding_idx");
	pgm.sql(
		"CREATE INDEX memory_facts_embedding_idx ON memory_facts USING ivfflat (embedding vector_cosine_ops)",
	);

	pgm.sql("DROP INDEX IF EXISTS memory_thinking_embedding_idx");
	pgm.sql(
		"CREATE INDEX memory_thinking_embedding_idx ON memory_thinking USING ivfflat (embedding vector_cosine_ops)",
	);

	pgm.sql("DROP INDEX IF EXISTS messages_embedding_idx");
	pgm.sql(
		"CREATE INDEX messages_embedding_idx ON messages USING ivfflat (embedding vector_cosine_ops)",
	);
};
