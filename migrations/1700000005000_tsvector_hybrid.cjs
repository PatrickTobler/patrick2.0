exports.up = (pgm) => {
	// Full-text search columns (auto-generated from text) for hybrid BM25 + cosine search
	pgm.sql(
		"ALTER TABLE memory_facts ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED",
	);
	pgm.sql("CREATE INDEX memory_facts_tsv_idx ON memory_facts USING GIN (tsv)");

	pgm.sql(
		"ALTER TABLE memory_thinking ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED",
	);
	pgm.sql("CREATE INDEX memory_thinking_tsv_idx ON memory_thinking USING GIN (tsv)");

	pgm.sql(
		"ALTER TABLE messages ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED",
	);
	pgm.sql("CREATE INDEX messages_tsv_idx ON messages USING GIN (tsv)");

	pgm.sql("ALTER TABLE todos ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED");
	pgm.sql("CREATE INDEX todos_tsv_idx ON todos USING GIN (tsv)");
};

exports.down = (pgm) => {
	pgm.sql("DROP INDEX IF EXISTS memory_facts_tsv_idx");
	pgm.sql("ALTER TABLE memory_facts DROP COLUMN IF EXISTS tsv");
	pgm.sql("DROP INDEX IF EXISTS memory_thinking_tsv_idx");
	pgm.sql("ALTER TABLE memory_thinking DROP COLUMN IF EXISTS tsv");
	pgm.sql("DROP INDEX IF EXISTS messages_tsv_idx");
	pgm.sql("ALTER TABLE messages DROP COLUMN IF EXISTS tsv");
	pgm.sql("DROP INDEX IF EXISTS todos_tsv_idx");
	pgm.sql("ALTER TABLE todos DROP COLUMN IF EXISTS tsv");
};
