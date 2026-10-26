import { describe, expect, it } from 'vitest';
import {
  AUTO_CHUNK_CEILING,
  AUTO_CHUNK_FLOOR,
  DEFAULT_MAX_CHUNKS,
  REQUEST_OVERHEAD_TOKENS,
  splitScrapedContent,
} from './chunking';

/* Chunk size is not just a performance knob: it used to feed a `chunks.length
 * > 1` condition that decided whether extraction ran at all, so raising it
 * silently stopped pages being reduced to facts. These tests pin the shape so
 * a tuning change cannot quietly become a behaviour change. */
describe('splitScrapedContent', () => {
  const long = 'word '.repeat(40_000);

  it('returns a single chunk for content that fits', () => {
    expect(splitScrapedContent('a short page', 16_384)).toHaveLength(1);
  });

  it('never returns more than the default chunk cap', () => {
    const chunks = splitScrapedContent(long, 16_384);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(DEFAULT_MAX_CHUNKS);
  });

  it('loses no content within a single chunk', () => {
    const page = 'The newest Caddy release is v2.11.7.';
    expect(splitScrapedContent(page, 16_384).join('')).toContain('v2.11.7');
  });

  it('produces chunks for an empty page without throwing', () => {
    expect(() => splitScrapedContent('', 16_384)).not.toThrow();
  });

  it('keeps the auto ceiling above the floor plus request overhead', () => {
    /* If this ever inverts, the derived chunk size is smaller than the
     * smallest useful one and every page becomes unreadable. */
    expect(AUTO_CHUNK_CEILING).toBeGreaterThan(
      AUTO_CHUNK_FLOOR + REQUEST_OVERHEAD_TOKENS,
    );
  });

  it('respects a smaller per-request context by producing more chunks', () => {
    const wide = splitScrapedContent(long, 32_768);
    const narrow = splitScrapedContent(long, 4_096);

    /* Both are capped, so assert the relationship rather than exact counts. */
    expect(narrow.length).toBeGreaterThanOrEqual(wide.length);
  });
});

/* Regression: a page with no sentence punctuation becomes one segment larger
 * than the chunk budget. The splitter's inner loop then breaks immediately,
 * leaving chunkEnd === chunkStart, and the outer loop never advanced -- it
 * spun forever pushing empty strings until V8 died on a 169 MB allocation.
 * Reachable from any scraped page containing minified text, a code block or a
 * wide table. */
describe('a segment larger than the chunk budget', () => {
  it('terminates instead of looping forever', () => {
    const unpunctuated = 'word '.repeat(40_000);

    const chunks = splitScrapedContent(unpunctuated, 16_384);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(DEFAULT_MAX_CHUNKS);
    expect(chunks.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
  });

  it('keeps the oversized segment rather than emitting empty chunks', () => {
    /* One unbroken run that exceeds the chunk budget -- a minified script or a
     * long table row. Deliberately not a single 200 KB string with no
     * whitespace: tiktoken takes minutes on that, which measures the tokenizer
     * rather than this function. */
    const blob = 'abcdefgh '.repeat(5_000);

    const chunks = splitScrapedContent(blob, 16_384);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].length).toBeGreaterThan(0);
  });
});
