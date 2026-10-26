-- Everything this fork adds, in one migration.
--
-- Previously six files (0003 track_chat_model, 0004 llm_calls, 0005
-- call_kinds, 0006 call_role, 0007 call_tokens, 0008 record_selection) that
-- grew one column at a time as the telemetry was built. The end state is small
-- enough to state once.
--
-- Safe for databases that already ran the old files: the runner records a
-- migration by its numeric prefix, not its filename, so an existing database
-- has '0003' recorded and skips this entirely. A fresh database runs it and
-- gets the whole schema.

-- Which chat model answered, and the settings that shaped the answer. Stored
-- as the provider's resolved display name rather than its id, so a row stays
-- readable after a provider is renamed or removed.
ALTER TABLE messages ADD COLUMN provider TEXT;--> statement-breakpoint
ALTER TABLE messages ADD COLUMN model TEXT;--> statement-breakpoint
ALTER TABLE messages ADD COLUMN mode TEXT;--> statement-breakpoint
ALTER TABLE messages ADD COLUMN answerStyle TEXT;--> statement-breakpoint

-- One row per model call, search, page fetch, embedding or model load. A
-- single search makes hundreds of these.
CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY,
    messageId TEXT,
    chatId TEXT,
    provider TEXT,
    model TEXT,
    -- Which job the call did: classifier, orchestrator, picker, extractor,
    -- writer, widget. Null for non-model work.
    role TEXT,
    -- 'model', 'search', 'scrape', 'embed' or 'load'.
    kind TEXT,
    label TEXT,
    method TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    -- Null while the call is still running; set when it finishes.
    durationMs INTEGER,
    firstChunkMs INTEGER,
    inputChars INTEGER,
    inputTokens INTEGER,
    outputChars INTEGER,
    -- Only populated while the debug capture switch is on.
    inputText TEXT,
    outputText TEXT,
    error TEXT
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS llm_calls_messageId_idx ON llm_calls (messageId);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS llm_calls_kind_idx ON llm_calls (kind);
