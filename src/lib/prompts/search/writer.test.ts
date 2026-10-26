import { describe, expect, it } from 'vitest';
import {
  AnswerStyle,
  defaultAnswerStyle,
  getWriterPrompt,
} from './writer';

/* Answer length and research depth were one dial, and the base prompt told
 * every mode to write a blog post regardless -- a one-line question produced
 * 2,680 characters in speed mode. These pin the two apart. */
describe('defaultAnswerStyle', () => {
  it('maps each mode to its own default', () => {
    expect(defaultAnswerStyle('speed')).toBe('brief');
    expect(defaultAnswerStyle('balanced')).toBe('standard');
    expect(defaultAnswerStyle('quality')).toBe('deep');
  });
});

describe('getWriterPrompt', () => {
  const styles: AnswerStyle[] = ['brief', 'standard', 'deep'];

  it('includes the requested style block, not the mode default', () => {
    /* Quality mode asking for brief must get brief: keying the length off the
     * mode is what made a flat token cap truncate quality answers. */
    const prompt = getWriterPrompt('ctx', '', 'quality', 'brief');

    expect(prompt).toContain('Answer style: BRIEF');
    expect(prompt).not.toContain('Answer style: DEEP');
  });

  it('tells brief to drop the scaffolding', () => {
    const prompt = getWriterPrompt('ctx', '', 'speed', 'brief');

    expect(prompt).toMatch(/No headings/i);
    expect(prompt).toMatch(/No concluding paragraph/i);
  });

  it('keeps per-sentence citation discipline in every style', () => {
    /* A shorter answer is not a reason to stop grounding it; this rule is what
     * the blocked-page and extraction-failure work exists to protect. */
    for (const style of styles) {
      const prompt = getWriterPrompt('ctx', '', 'speed', style);
      expect(prompt).toContain('every sentence in your response includes at least one citation');
    }
  });

  it('embeds the context and the user instructions', () => {
    const prompt = getWriterPrompt('SOURCE-MATERIAL', 'BE-TERSE', 'speed', 'brief');

    expect(prompt).toContain('SOURCE-MATERIAL');
    expect(prompt).toContain('BE-TERSE');
  });

  it('falls back to the mode default when no style is given', () => {
    expect(getWriterPrompt('ctx', '', 'quality')).toContain('Answer style: DEEP');
  });
});
