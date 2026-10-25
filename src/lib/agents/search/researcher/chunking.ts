import configManager from '@/lib/config';
import { splitText } from '@/lib/utils/splitText';

const DEFAULT_CHUNK_TOKENS = 4000;
const DEFAULT_MAX_CHUNKS = 3;

/* What a request needs on top of the chunk itself: the extractor's system
 * prompt and query, its own output, and slack for tokeniser disagreement
 * between js-tiktoken here and the model's own tokeniser. */
export const REQUEST_OVERHEAD_TOKENS = 2000;

/* The value that worked before any of this was tuned.
 *
 * It was briefly raised to 12,000, which was a mistake worth recording: that
 * number came from the shape of an experiment -- 3x4k against 1x12k, where 12k
 * only made the comparison fair -- and the experiment's own result was that
 * chunking is *cost-neutral* (63.8s against 60.5s for the same content). So
 * there was no measured benefit to larger chunks beyond ~5% fewer round trips,
 * and the larger size came with a cost: all three observed `?` degeneration
 * collapses happened on prompts of 12,000+ tokens, while every call at
 * 1,200-2,800 tokens succeeded.
 *
 * Auto-sizing therefore only ever shrinks: it protects against a slot too
 * small for a chunk, and never pushes a chunk past a size already known to
 * work. */
const AUTO_CHUNK_CEILING = 4000;

/* Below this, chunks are too small to extract anything coherent from. */
export const AUTO_CHUNK_FLOOR = 1000;

const overlapFor = (chunkTokens: number) =>
  Math.min(500, Math.max(32, Math.floor(chunkTokens / 8)));

const positiveInt = (value: unknown): number | null => {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Chunk size for a page, preferring an explicit setting and otherwise sizing to
 * what one request to this model can hold.
 *
 * Auto-sizing matters because the manual setting has to be guessed: the usable
 * window is the provider's context divided by its parallel slots, so a value
 * that fits today silently overflows when parallelism changes.
 */
/* null when the user has not set one, which is what lets the caller tell an
 * explicit choice apart from the automatic size. */
export const getConfiguredChunkTokens = (): number | null =>
  positiveInt(configManager.getConfig('search.chunkTokens', null));

export const getChunkTokens = (contextPerRequest?: number): number => {
  const configured = getConfiguredChunkTokens();

  if (configured) return configured;

  if (!contextPerRequest) return DEFAULT_CHUNK_TOKENS;

  const usable = contextPerRequest - REQUEST_OVERHEAD_TOKENS;

  return Math.max(
    AUTO_CHUNK_FLOOR,
    Math.min(AUTO_CHUNK_CEILING, usable > 0 ? usable : AUTO_CHUNK_FLOOR),
  );
};

/**
 * Splits scraped page content the way the research actions want it.
 *
 * Shared because both the scrape action and the quality search branch do this,
 * and a difference between them would be invisible while changing how much a
 * page costs to read. Each chunk becomes its own model call, so the chunk count
 * is the main lever on how long reading a page takes.
 */
export const splitScrapedContent = (
  content: string,
  contextPerRequest?: number,
): string[] => {
  const chunkTokens = getChunkTokens(contextPerRequest);
  const chunks = splitText(content, chunkTokens, overlapFor(chunkTokens));

  /* A field's declared default only populates the settings form; nothing
   * writes it to the config, so this fallback is what an unconfigured install
   * actually gets. */
  const configured = configManager.getConfig(
    'search.maxChunksPerPage',
    DEFAULT_MAX_CHUNKS,
  );
  const maxChunks = Number.parseInt(String(configured ?? ''), 10);

  /* Explicit 0 means read everything. Anything unparseable -- including an
   * empty field -- falls back to the default rather than silently removing the
   * cap. */
  if (maxChunks === 0) return chunks;
  if (!Number.isFinite(maxChunks) || maxChunks < 0)
    return chunks.slice(0, DEFAULT_MAX_CHUNKS);

  return chunks.slice(0, maxChunks);
};
