import SessionManager from '@/lib/session';
import { ResearchProgress } from '@/lib/types';

/**
 * Mutates the research block's progress and emits it.
 *
 * Shared by the loop and by every action that scrapes, so the counters live in
 * one place rather than being reimplemented per action.
 *
 * The patch targets /data/progress specifically. Every other research update
 * replaces the whole subSteps array, and progress changes far more often than
 * the sub-steps do, so they must not drag that array along with them.
 */
export const patchProgress = (
  session: SessionManager,
  blockId: string,
  mutate: (progress: ResearchProgress) => void,
) => {
  const block = session.getBlock(blockId);

  if (!block || block.type !== 'research' || !block.data.progress) return;

  mutate(block.data.progress);

  session.updateBlock(blockId, [
    {
      op: 'replace',
      path: '/data/progress',
      value: block.data.progress,
    },
  ]);
};

/**
 * Sets the status line, and the phase it belongs to.
 *
 * Separate from patchProgress because this is the one field the UI shows as
 * prose, and stamping `currentSince` alongside it lets the client age the
 * message without the server pushing a tick.
 */
export const setCurrent = (
  session: SessionManager,
  blockId: string,
  phase: ResearchProgress['phase'],
  current?: string,
) =>
  patchProgress(session, blockId, (p) => {
    p.phase = phase;
    p.current = current;
    p.currentSince = current ? new Date().toISOString() : undefined;
  });

/* A URL's host, for status lines. Falls back to the raw string so an unparseable
 * URL still says something. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
