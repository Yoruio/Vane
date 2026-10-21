import configManager from '@/lib/config';
import { splitText } from '@/lib/utils/splitText';

/* Overlap exists so a sentence split across a boundary is still readable in
 * context; it only needs to be a fraction of the chunk, and a fixed 500 would
 * be most of a small chunk. */
const overlapFor = (chunkTokens: number) =>
  Math.min(500, Math.max(32, Math.floor(chunkTokens / 8)));

const DEFAULT_MAX_CHUNKS = 3;

const positiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Splits scraped page content the way the research actions want it.
 *
 * Shared because both the scrape action and the quality search branch do this,
 * and a difference between them would be invisible but change how much a page
 * costs to read. Each chunk becomes its own model call, so the chunk count is
 * the main lever on how long reading a page takes.
 */
export const splitScrapedContent = (content: string): string[] => {
  const chunkTokens = positiveInt(
    configManager.getConfig('search.chunkTokens', 4000),
    4000,
  );

  const chunks = splitText(content, chunkTokens, overlapFor(chunkTokens));

  /* A field's declared default only populates the settings form; nothing
   * writes it to the config, so an unconfigured install reads as absent and
   * the fallback here is what actually applies. */
  const configured = configManager.getConfig(
    'search.maxChunksPerPage',
    DEFAULT_MAX_CHUNKS,
  );
  const maxChunks = Number.parseInt(String(configured ?? ''), 10);

  /* Explicit 0 means read everything. Anything unparseable -- including an
   * empty field -- falls back to the default rather than silently removing
   * the cap. */
  if (maxChunks === 0) return chunks;
  if (!Number.isFinite(maxChunks) || maxChunks < 0)
    return chunks.slice(0, DEFAULT_MAX_CHUNKS);

  return chunks.slice(0, maxChunks);
};

export const getChunkTokens = () =>
  positiveInt(configManager.getConfig('search.chunkTokens', 4000), 4000);
