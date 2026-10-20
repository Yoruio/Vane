import { Chunk } from '@/lib/types';
import BaseEmbedding from './embedding';
import { CallContext, recordCall } from '@/lib/telemetry';

/**
 * Wraps a BaseEmbedding and records one row per call, so embedding work shows
 * up on the same timeline as model calls, searches and page fetches.
 *
 * This was the last unaccounted cost in a run: baseSearch embeds the query and
 * then every single result, and with a local in-process model that is seconds
 * of wall clock between a search finishing and the next model call starting.
 */
class InstrumentedEmbedding<CONFIG> extends BaseEmbedding<CONFIG> {
  constructor(
    private inner: BaseEmbedding<CONFIG>,
    private ctx: CallContext & { provider?: string; model?: string },
  ) {
    // The wrapper holds no config of its own; `inner` owns it.
    super(undefined as unknown as CONFIG);
  }

  private async record(
    method: string,
    start: number,
    startedAt: string,
    count: number,
    error?: unknown,
  ) {
    await recordCall(this.ctx, {
      kind: 'embed',
      method,
      /* The texts themselves are the search results, already stored on the
       * calls that produced them; the count is what explains the duration. */
      label: `${count} ${count === 1 ? 'text' : 'texts'}`,
      provider: this.ctx.provider,
      model: this.ctx.model,
      startedAt,
      durationMs: Date.now() - start,
      error,
    });
  }

  async embedText(texts: string[]): Promise<number[][]> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const out = await this.inner.embedText(texts);
      await this.record('embedText', start, startedAt, texts.length);
      return out;
    } catch (err) {
      await this.record('embedText', start, startedAt, texts.length, err);
      throw err;
    }
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const out = await this.inner.embedChunks(chunks);
      await this.record('embedChunks', start, startedAt, chunks.length);
      return out;
    } catch (err) {
      await this.record('embedChunks', start, startedAt, chunks.length, err);
      throw err;
    }
  }
}

export default InstrumentedEmbedding;
