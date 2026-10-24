import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ReadingResearchBlock } from '@/lib/types';
import Scraper from '@/lib/scraper';
import { patchProgress } from '../progress';
import { timeCall } from '@/lib/telemetry';
import { withRole } from '@/lib/models/base/instrumented';
import { extractFacts } from '../extract';
import { hostOf } from '../progress';



const schema = z.object({
  urls: z.array(z.string()).describe('A list of URLs to scrape content from.'),
});

const actionDescription = `
Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.
You should only call this tool when the user has specifically requested information from certain web pages, never call this yourself to get extra information without user instruction.

For example, if the user says "Please summarize the content of https://example.com/article", you can call this tool with that URL to get the content and then provide the summary or "What does X mean according to https://example.com/page", you can call this tool with that URL to get the content and provide the explanation.
`;

const scrapeURLAction: ResearchAction<typeof schema> = {
  name: 'scrape_url',
  schema: schema,
  getToolDescription: () =>
    'Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.',
  getDescription: () => actionDescription,
  enabled: (_) => true,
  execute: async (params, additionalConfig) => {
    params.urls = params.urls.slice(0, 3);

    let readingBlockId = crypto.randomUUID();
    let readingEmitted = false;

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );

    const results: Chunk[] = [];

    await Promise.all(
      params.urls.map(async (url) => {
        try {
          patchProgress(
            additionalConfig.session,
            additionalConfig.researchBlockId,
            (p) => {
              p.phase = 'reading';
              p.scrape.inFlight++;
              /* Host rather than the full URL: this is a one-line status, and a
               * long URL pushes the counters off the end of it. */
              p.current = `Reading ${hostOf(url)}`;
              p.currentSince = new Date().toISOString();
            },
          );

          /* finally, because scrape() can still throw before its own try
           * (an uninitialised browser) and a leaked inFlight never recovers. */
          let scraped;
          try {
            scraped = await timeCall(
              additionalConfig.callContext,
              { kind: 'scrape', method: 'playwright', label: url },
              () => Scraper.scrape(url),
              (r) => (r.ok ? `${r.content.length} chars` : 'failed'),
            );
          } finally {
            patchProgress(
              additionalConfig.session,
              additionalConfig.researchBlockId,
              (p) => p.scrape.inFlight--,
            );
          }

          patchProgress(
            additionalConfig.session,
            additionalConfig.researchBlockId,
            (p) => {
              if (scraped.ok) p.scrape.completed++;
              else p.scrape.failed++;
            },
          );

          /* A page that could not be read is not a source. Extracting from the
           * stub wastes a model call and puts an empty "finding" in front of
           * the writer, which is how two blocked pages became citations. */
          if (!scraped.ok) return;

          if (
            !readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            readingEmitted = true;
            researchBlock.data.subSteps.push({
              id: readingBlockId,
              type: 'reading',
              reading: [
                {
                  content: '',
                  metadata: {
                    url,
                    title: scraped.title,
                  },
                },
              ],
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          } else if (
            readingEmitted &&
            researchBlock &&
            researchBlock.type === 'research'
          ) {
            const subStepIndex = researchBlock.data.subSteps.findIndex(
              (step: any) => step.id === readingBlockId,
            );

            const subStep = researchBlock.data.subSteps[
              subStepIndex
            ] as ReadingResearchBlock;

            subStep.reading.push({
              content: '',
              metadata: {
                url,
                title: scraped.title,
              },
            });

            additionalConfig.session.updateBlock(
              additionalConfig.researchBlockId,
              [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: researchBlock.data.subSteps,
                },
              ],
            );
          }

          /* fallbackToRaw: this tool runs because the user named a URL, so
           * handing back unextracted page text beats handing back nothing.
           * The search action makes the opposite choice and drops the source. */
          const extraction = await extractFacts({
            llm: additionalConfig.llm,
            content: scraped.content,
            queries: [additionalConfig.query ?? 'Summarize'],
            session: additionalConfig.session,
            researchBlockId: additionalConfig.researchBlockId,
            contextPerRequest: additionalConfig.contextPerRequest,
            fallbackToRaw: true,
          });

          const accumulatedContent = extraction.content;

          if (extraction.rawFallback) {
            console.error(
              `Extraction failed on every chunk of ${params.urls}; returning raw page text. ` +
                `${extraction.chunksFailed}/${extraction.chunksTotal} chunks failed.`,
            );
          } else if (extraction.chunksFailed > 0) {
            console.error(
              `Partial extraction: ${extraction.chunksFailed} of ${extraction.chunksTotal} chunks failed.`,
            );
          }

          results.push({
            content: accumulatedContent,
            metadata: {
              url,
              title: scraped.title,
            },
          });
        } catch (error) {
          patchProgress(
            additionalConfig.session,
            additionalConfig.researchBlockId,
            (p) => p.scrape.failed++,
          );

          results.push({
            content: `Failed to fetch content from ${url}: ${error}`,
            metadata: {
              url,
              title: `Error scraping ${url}`,
            },
          });
        }
      }),
    );

    return {
      type: 'search_results',
      results,
    };
  },
};

export default scrapeURLAction;
