import { getEncoding } from 'js-tiktoken';

const splitRegex = /(?<=\. |\n|! |\? |; |:\s|\d+\.\s|- |\* )/g;

const enc = getEncoding('cl100k_base');

export const getTokenCount = (text: string): number => {
  try {
    return enc.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
};

export const splitText = (
  text: string,
  maxTokens = 512,
  overlapTokens = 64,
): string[] => {
  const segments = text.split(splitRegex).filter(Boolean);

  if (segments.length === 0) {
    return [];
  }

  const segmentTokenCounts = segments.map(getTokenCount);

  const result: string[] = [];

  let chunkStart = 0;

  while (chunkStart < segments.length) {
    let chunkEnd = chunkStart;
    let currentTokenCount = 0;

    while (chunkEnd < segments.length && currentTokenCount < maxTokens) {
      if (currentTokenCount + segmentTokenCounts[chunkEnd] > maxTokens) {
        break;
      }

      currentTokenCount += segmentTokenCounts[chunkEnd];
      chunkEnd++;
    }

    let overlapBeforeStart = Math.max(0, chunkStart - 1);
    let overlapBeforeTokenCount = 0;

    while (overlapBeforeStart >= 0 && overlapBeforeTokenCount < overlapTokens) {
      if (
        overlapBeforeTokenCount + segmentTokenCounts[overlapBeforeStart] >
        overlapTokens
      ) {
        break;
      }

      overlapBeforeTokenCount += segmentTokenCounts[overlapBeforeStart];
      overlapBeforeStart--;
    }

    const overlapStartIndex = Math.max(0, overlapBeforeStart + 1);

    const overlapBeforeContent = segments
      .slice(overlapStartIndex, chunkStart)
      .join('');

    /* A single segment larger than maxTokens makes the inner loop break
     * immediately, leaving chunkEnd === chunkStart. Without this the outer
     * loop never advances: it spins forever pushing empty strings until the
     * process dies -- observed as a 169 MB allocation and a V8 fatal error on
     * a 200 KB page with no sentence punctuation, which is what minified text,
     * a code block or a wide table looks like.
     *
     * Take the oversized segment on its own. It exceeds the per-request
     * budget, so the caller may still have to reject it, but one too-large
     * chunk is a problem the caller can see and handle. */
    if (chunkEnd === chunkStart) {
      result.push(segments[chunkStart]);
      chunkStart += 1;
      continue;
    }

    const chunkContent = segments.slice(chunkStart, chunkEnd).join('');

    result.push(overlapBeforeContent + chunkContent);

    chunkStart = chunkEnd;
  }

  return result;
};
