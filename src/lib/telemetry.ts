import db from './db';
import { llmCalls } from './db/schema';
import { eq } from 'drizzle-orm';

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
  inputTokens?: number;
  startedAt: string;
  durationMs?: number;
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
 * Opens a row for a call that has just started, and returns its id.
 *
 * A row written only on completion leaves the call you are waiting on -- the
 * one that matters while a search is slow -- absent from the timeline. Opening
 * it with a null duration makes it visible immediately, and the reader can age
 * it from `startedAt`.
 *
 * Returns null if the write fails; callers treat that as "not recorded" rather
 * than failing the call.
 */
export const beginCall = async (
  ctx: CallContext,
  row: Omit<CallRow, 'durationMs' | 'outputText' | 'error' | 'firstChunkMs'>,
): Promise<number | null> => {
  try {
    const [inserted] = await db
      .insert(llmCalls)
      .values({
        messageId: ctx.messageId,
        chatId: ctx.chatId,
        kind: row.kind,
        label: row.label,
        role: row.role,
        provider: row.provider,
        model: row.model,
        method: row.method,
        startedAt: row.startedAt,
        /* Null duration is the marker for "still running". */
        durationMs: null,
        inputChars: row.inputText?.length,
        inputTokens: row.inputTokens,
        inputText: ctx.captureText ? row.inputText : null,
      })
      .returning({ id: llmCalls.id });

    return inserted?.id ?? null;
  } catch (err) {
    console.error('Failed to open call record:', err);
    return null;
  }
};

/** Closes a row opened by beginCall. */
export const completeCall = async (
  id: number | null,
  ctx: CallContext,
  row: Pick<
    CallRow,
    'durationMs' | 'firstChunkMs' | 'outputText' | 'error'
  >,
) => {
  if (id === null) return;

  try {
    await db
      .update(llmCalls)
      .set({
        durationMs: row.durationMs,
        firstChunkMs: row.firstChunkMs,
        outputChars: row.outputText?.length,
        outputText: ctx.captureText ? row.outputText : null,
        error: row.error === undefined ? null : message(row.error),
      })
      .where(eq(llmCalls.id, id));
  } catch (err) {
    console.error('Failed to close call record:', err);
  }
};

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
      inputTokens: row.inputTokens,
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

  /* Opened before the work starts so a slow page fetch is visible while it is
   * still fetching, rather than appearing once it is too late to matter. */
  const opened = beginCall(ctx, { ...row, startedAt, inputText: row.label });

  try {
    const result = await work();

    await completeCall(await opened, ctx, {
      durationMs: Date.now() - start,
      outputText: describe?.(result),
    });

    return result;
  } catch (err) {
    await completeCall(await opened, ctx, {
      durationMs: Date.now() - start,
      error: err,
    });

    throw err;
  }
};
