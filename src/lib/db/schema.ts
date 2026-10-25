import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { Block } from '../types';
import { SearchSources } from '../agents/search/types';

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey(),
  messageId: text('messageId').notNull(),
  chatId: text('chatId').notNull(),
  backendId: text('backendId').notNull(),
  query: text('query').notNull(),
  createdAt: text('createdAt').notNull(),
  responseBlocks: text('responseBlocks', { mode: 'json' })
    .$type<Block[]>()
    .default(sql`'[]'`),
  status: text({ enum: ['answering', 'completed', 'error'] }).default(
    'answering',
  ),
  // Which chat model answered. Stored as resolved values rather than the
  // provider id so a row stays readable after a provider is renamed or
  // removed from the config. Null for messages written before 0003.
  provider: text('provider'),
  model: text('model'),
  // The settings that produced it. Without these a stored answer cannot be
  // explained: the same model and question give a 435-character or a
  // 2,317-character answer depending on these two, and mode also decides how
  // much research happened. Null for rows written before 0008.
  mode: text('mode'),
  answerStyle: text('answerStyle'),
  // Exactly the context the writer was handed, so the answer can be rewritten
  // at a different length without repeating minutes of research. Large (tens
  // of KB) but written once per message.
  writerContext: text('writerContext'),
});

// One row per model call. A single search makes hundreds of these (one
// generateObject per scraped chunk), so the text columns are only populated
// when the `debug.captureLlmText` setting is on — see InstrumentedLLM.
export const llmCalls = sqliteTable('llm_calls', {
  id: integer('id').primaryKey(),
  messageId: text('messageId'),
  chatId: text('chatId'),
  provider: text('provider'),
  model: text('model'),
  /* 'model', 'search' or 'scrape'. Null on rows written before the column
   * existed, which were all model calls. */
  kind: text('kind'),
  /* What the span was about: the query for a search, the URL for a scrape. */
  label: text('label'),
  /* The job the call did -- classifier, orchestrator, picker, extractor,
   * writer, widget. `method` is only the SDK mechanism, and several roles share
   * one, so this is what makes a timeline readable. */
  role: text('role'),
  method: text('method').notNull(),
  startedAt: text('startedAt').notNull(),
  durationMs: integer('durationMs'),
  // Streaming only: time to the first chunk, which is a separate question from
  // total duration when comparing backends.
  firstChunkMs: integer('firstChunkMs'),
  inputChars: integer('inputChars'),
  /* Counted with js-tiktoken before the call. Characters are a poor proxy for
   * how close a prompt is to the context limit, and the limit is what ends a
   * run. */
  inputTokens: integer('inputTokens'),
  outputChars: integer('outputChars'),
  inputText: text('inputText'),
  outputText: text('outputText'),
  error: text('error'),
});

interface DBFile {
  name: string;
  fileId: string;
}

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: text('createdAt').notNull(),
  sources: text('sources', {
    mode: 'json',
  })
    .$type<SearchSources[]>()
    .default(sql`'[]'`),
  files: text('files', { mode: 'json' })
    .$type<DBFile[]>()
    .default(sql`'[]'`),
});
