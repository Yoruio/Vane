CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY,
    messageId TEXT,
    chatId TEXT,
    provider TEXT,
    model TEXT,
    method TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    durationMs INTEGER,
    firstChunkMs INTEGER,
    inputChars INTEGER,
    outputChars INTEGER,
    inputText TEXT,
    outputText TEXT,
    error TEXT
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS llm_calls_messageId_idx ON llm_calls (messageId);
