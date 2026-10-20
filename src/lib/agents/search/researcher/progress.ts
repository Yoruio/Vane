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
