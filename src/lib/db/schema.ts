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
  method: text('method').notNull(),
  startedAt: text('startedAt').notNull(),
  durationMs: integer('durationMs'),
  // Streaming only: time to the first chunk, which is a separate question from
  // total duration when comparing backends.
  firstChunkMs: integer('firstChunkMs'),
  inputChars: integer('inputChars'),
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
