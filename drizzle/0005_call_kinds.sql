ALTER TABLE llm_calls ADD COLUMN kind TEXT;--> statement-breakpoint
ALTER TABLE llm_calls ADD COLUMN label TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS llm_calls_kind_idx ON llm_calls (kind);
