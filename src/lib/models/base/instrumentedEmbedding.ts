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
    texts: string[],
    vectors?: number[][],
    error?: unknown,
  ) {
    await recordCall(this.ctx, {
      kind: 'embed',
      method,
      label: `${texts.length} ${texts.length === 1 ? 'text' : 'texts'}`,
      provider: this.ctx.provider,
      model: this.ctx.model,
      startedAt,
      durationMs: Date.now() - start,
      /* Recorded like every other kind so the capture switch means the same
       * thing everywhere: without it the detail view would claim the text was
       * withheld by a setting that never applied to embeddings. The input is
       * what explains a slow call -- which text was long. */
      inputText: texts.join('\n---\n'),
      outputText: vectors
        ? `${vectors.length} ${vectors.length === 1 ? 'vector' : 'vectors'} x ${vectors[0]?.length ?? 0} dims`
        : undefined,
      error,
    });
  }

  async embedText(texts: string[]): Promise<number[][]> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    try {
      const out = await this.inner.embedText(texts);
      await this.record('embedText', start, startedAt, texts, out);
      return out;
    } catch (err) {
      await this.record('embedText', start, startedAt, texts, undefined, err);
      throw err;
    }
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const texts = chunks.map((c) => c.content);

    try {
      const out = await this.inner.embedChunks(chunks);
      await this.record('embedChunks', start, startedAt, texts, out);
      return out;
    } catch (err) {
      await this.record('embedChunks', start, startedAt, texts, undefined, err);
      throw err;
    }
  }
}

export default InstrumentedEmbedding;
