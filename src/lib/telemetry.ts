import db from './db';
import { llmCalls } from './db/schema';

export type CallKind = 'model' | 'search' | 'scrape' | 'embed' | 'load';

export type CallContext = {
  messageId?: string;
  chatId?: string;
  /* Persist the full input and output. Off by default: a single search can
   * make hundreds of calls with ~4000-token prompts. */
  captureText?: boolean;
};

type CallRow = {
  kind: CallKind;
  method: string;
  role?: string;
  startedAt: string;
  durationMs: number;
  label?: string;
  provider?: string;
  model?: string;
  firstChunkMs?: number;
  inputText?: string;
  outputText?: string;
  error?: unknown;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Writes one timing row. Shared by the model-call decorator and by the search
 * and scrape spans so every kind of work lands on the same timeline.
 *
 * Never throws: telemetry must not be able to break a search.
 */
export const recordCall = async (ctx: CallContext, row: CallRow) => {
  try {
    await db.insert(llmCalls).values({
      messageId: ctx.messageId,
      chatId: ctx.chatId,
      kind: row.kind,
      label: row.label,
      role: row.role,
      provider: row.provider,
      model: row.model,
      method: row.method,
      startedAt: row.startedAt,
      durationMs: row.durationMs,
      firstChunkMs: row.firstChunkMs,
      inputChars: row.inputText?.length,
      outputChars: row.outputText?.length,
      inputText: ctx.captureText ? row.inputText : null,
      outputText: ctx.captureText ? row.outputText : null,
      error: row.error === undefined ? null : message(row.error),
    });
  } catch (err) {
    console.error('Failed to record call:', err);
  }
};

/**
 * Times `work` and records it. Used for search and scrape, where there is no
 * decorator to hang the timing on; errors are recorded and rethrown.
 */
export const timeCall = async <T>(
  ctx: CallContext | undefined,
  row: Pick<CallRow, 'kind' | 'method' | 'label'>,
  work: () => Promise<T>,
  describe?: (result: T) => string,
): Promise<T> => {
  /* No context means the caller is outside a chat -- the discover feed and the
   * media agents also search -- and there is nothing to attribute the row to. */
  if (!ctx?.messageId) return work();

  const startedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const result = await work();

    await recordCall(ctx, {
      ...row,
      startedAt,
      durationMs: Date.now() - start,
      inputText: row.label,
      outputText: describe?.(result),
    });

    return result;
  } catch (err) {
    await recordCall(ctx, {
      ...row,
      startedAt,
      durationMs: Date.now() - start,
      inputText: row.label,
      error: err,
    });

    throw err;
  }
};
