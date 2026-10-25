'use client';

import { cn } from '@/lib/utils';
import { useChat } from '@/lib/hooks/useChat';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/* Four stops rather than three: "auto" has to be reachable, because it is the
 * only setting that lets the research depth decide the answer length, and it is
 * the default. Ordered shortest-to-longest so the track reads as a length. */
const STOPS = [
  { key: 'auto', label: 'Auto', hint: 'Length follows research depth' },
  { key: 'brief', label: 'Brief', hint: 'Answer the question, 2–4 sentences' },
  { key: 'standard', label: 'Standard', hint: 'Short answer with a few bullets' },
  { key: 'deep', label: 'Deep', hint: 'Full written report' },
];

const AnswerLength = () => {
  const { answerStyle, setAnswerStyle } = useChat();

  const index = Math.max(
    0,
    STOPS.findIndex((s) => s.key === (answerStyle || 'auto')),
  );
  const current = STOPS[index];

  /* The thumb is positioned from the active button's measured box rather than
   * computed as index/count.
   *
   * Computing it assumed every stop was the same width, which "Auto" and
   * "Standard" are not. Forcing equal widths with a 4-column grid made it
   * worse: the columns can shrink below their content, so "Standard" overflowed
   * its cell and overlapped "Deep". Measuring works whatever the labels are. */
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
    null,
  );

  const measure = useCallback(() => {
    const track = trackRef.current;
    const button = buttonRefs.current[index];

    if (!track || !button) return;

    setThumb({ left: button.offsetLeft, width: button.offsetWidth });
  }, [index]);

  useLayoutEffect(() => {
    measure();

    /* Fonts loading, the window resizing, or the input bar reflowing all move
     * the buttons after first paint. */
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);

    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      className="flex flex-row items-center"
      title={`Answer length — ${current.label}: ${current.hint}`}
    >
      <div
        ref={trackRef}
        role="radiogroup"
        aria-label="Answer length"
        className="relative flex flex-row items-center rounded-full bg-light-200 dark:bg-dark-200 p-0.5"
      >
        {thumb && (
          <span
            aria-hidden
            className="absolute top-0.5 bottom-0.5 rounded-full bg-light-primary dark:bg-dark-primary shadow-sm transition-all duration-200 ease-out"
            style={{ left: thumb.left, width: thumb.width }}
          />
        )}

        {STOPS.map((stop, i) => {
          const active = stop.key === current.key;

          return (
            <button
              key={stop.key}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setAnswerStyle(stop.key)}
              title={`${stop.label} — ${stop.hint}`}
              className={cn(
                /* whitespace-nowrap so a label can never wrap or be clipped,
                 * and the weight stays constant across states: bolding the
                 * active label changed its width, which moved every other stop
                 * and made the control jitter on each click. */
                'relative z-10 px-2.5 py-1 text-[11px] whitespace-nowrap rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
                active
                  ? 'text-black dark:text-white'
                  : 'text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80',
              )}
            >
              {stop.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default AnswerLength;
