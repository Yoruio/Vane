import BaseEmbedding from '@/lib/models/base/embedding';
import BaseLLM from '@/lib/models/base/llm';
import { searchSearxng, SearxngSearchOptions } from '@/lib/searxng';
import SessionManager from '@/lib/session';
import { Chunk, ResearchBlock, SearchResultsResearchBlock } from '@/lib/types';
import { SearchAgentConfig } from '../../../types';
import computeSimilarity from '@/lib/utils/computeSimilarity';
import z from 'zod';
import Scraper from '@/lib/scraper';
import { patchProgress } from '../../progress';
import { CallContext, timeCall } from '@/lib/telemetry';
import { withRole } from '@/lib/models/base/instrumented';
import { extractFacts } from '../../extract';

/* Enough of a result to judge relevance against the query. The picker reads
 * titles and URLs plus this much text; it does not need the page. */
const PICKER_SNIPPET_CHARS = 300;

/* The sub-step is display-only, and the UI reads just the url and title.
 * Emitting the pipeline's own objects would ship metadata.embedding -- a full
 * float vector per result -- to the browser, and because every research patch
 * replaces the whole subSteps array it would be re-sent on every later update.
 * The vectors cannot simply be deleted earlier: `similarity` is still needed to
 * sort, so strip a copy instead. */
const toDisplayChunk = (chunk: Chunk): Chunk => ({
  content: chunk.content,
  metadata: {
    url: chunk.metadata.url,
    title: chunk.metadata.title,
  },
});


export const executeSearch = async (input: {
  queries: string[];
  mode: SearchAgentConfig['mode'];
  searchConfig?: SearxngSearchOptions;
  researchBlock: ResearchBlock;
  session: InstanceType<typeof SessionManager>;
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
  callContext?: CallContext;
  contextPerRequest?: number;
}) => {
  const researchBlock = input.researchBlock;

  researchBlock.data.subSteps.push({
    id: crypto.randomUUID(),
    type: 'searching',
    searching: input.queries,
  });

  input.session.updateBlock(researchBlock.id, [
    {
      op: 'replace',
      path: '/data/subSteps',
      value: researchBlock.data.subSteps,
    },
  ]);

  if (input.mode === 'speed' || input.mode === 'balanced') {
    const searchResultsBlockId = crypto.randomUUID();
    let searchResultsEmitted = false;

    const results: Chunk[] = [];

    const search = async (q: string) => {
      const res = await timeCall(
        input.callContext,
        { kind: 'search', method: 'searxng', label: q },
        () =>
          searchSearxng(q, {
            ...(input.searchConfig ? input.searchConfig : {}),
          }),
        (r) => `${r.results.length} results`,
      );

      let resultChunks: Chunk[] = [];

      try {
        const queryEmbedding = (await input.embedding.embedText([q]))[0];

        resultChunks = (
          await Promise.all(
            res.results.map(async (r) => {
              const content = r.content || r.title;
              const chunkEmbedding = (
                await input.embedding.embedText([content])
              )[0];

              return {
                content,
                metadata: {
                  title: r.title,
                  url: r.url,
                  similarity: computeSimilarity(queryEmbedding, chunkEmbedding),
                  embedding: chunkEmbedding,
                },
              };
            }),
          )
        ).filter((c) => c.metadata.similarity > 0.5);
      } catch (err) {
        resultChunks = res.results.map((r) => {
          const content = r.content || r.title;

          return {
            content,
            metadata: {
              title: r.title,
              url: r.url,
              similarity: 1,
              embedding: [],
            },
          };
        });
      } finally {
        results.push(...resultChunks);
      }

      if (!searchResultsEmitted) {
        searchResultsEmitted = true;

        researchBlock.data.subSteps.push({
          id: searchResultsBlockId,
          type: 'search_results',
          reading: resultChunks.map(toDisplayChunk),
        });

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      } else if (searchResultsEmitted) {
        const subStepIndex = researchBlock.data.subSteps.findIndex(
          (step) => step.id === searchResultsBlockId,
        );

        const subStep = researchBlock.data.subSteps[
          subStepIndex
        ] as SearchResultsResearchBlock;

        subStep.reading.push(...resultChunks.map(toDisplayChunk));

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      }
    };

    await Promise.all(input.queries.map(search));

    results.sort((a, b) => b.metadata.similarity - a.metadata.similarity);

    const uniqueSearchResultIndices: Set<number> = new Set();

    for (let i = 0; i < results.length; i++) {
      let isDuplicate = false;

      for (const indice of uniqueSearchResultIndices.keys()) {
        if (
          results[i].metadata.embedding.length === 0 ||
          results[indice].metadata.embedding.length === 0
        )
          continue;

        const similarity = computeSimilarity(
          results[i].metadata.embedding,
          results[indice].metadata.embedding,
        );

        if (similarity > 0.75) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueSearchResultIndices.add(i);
      }
    }

    const uniqueSearchResults = Array.from(uniqueSearchResultIndices.keys())
      .map((i) => {
        const uniqueResult = results[i];

        delete uniqueResult.metadata.embedding;
        delete uniqueResult.metadata.similarity;

        return uniqueResult;
      })
      .slice(0, 20);

    return uniqueSearchResults;
  } else if (input.mode === 'quality') {
    const searchResultsBlockId = crypto.randomUUID();
    let searchResultsEmitted = false;

    const searchResults: Chunk[] = [];

    const search = async (q: string) => {
      const res = await timeCall(
        input.callContext,
        { kind: 'search', method: 'searxng', label: q },
        () =>
          searchSearxng(q, {
            ...(input.searchConfig ? input.searchConfig : {}),
          }),
        (r) => `${r.results.length} results`,
      );

      let resultChunks: Chunk[] = [];

      resultChunks = res.results.map((r) => {
        const content = r.content || r.title;

        return {
          content,
          metadata: {
            title: r.title,
            url: r.url,
            similarity: 1,
            embedding: [],
          },
        };
      });

      searchResults.push(...resultChunks);

      if (!searchResultsEmitted) {
        searchResultsEmitted = true;

        researchBlock.data.subSteps.push({
          id: searchResultsBlockId,
          type: 'search_results',
          reading: resultChunks.map(toDisplayChunk),
        });

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      } else if (searchResultsEmitted) {
        const subStepIndex = researchBlock.data.subSteps.findIndex(
          (step) => step.id === searchResultsBlockId,
        );

        const subStep = researchBlock.data.subSteps[
          subStepIndex
        ] as SearchResultsResearchBlock;

        subStep.reading.push(...resultChunks.map(toDisplayChunk));

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      }
    };

    await Promise.all(input.queries.map(search));

    const pickerPrompt = `
      Assistant is an AI search result picker. Assistant's task is to pick 2-3 of the most relevant search results based off the query which can be then scraped for information to answer the query.
      Assistant will be shared with the search results retrieved from a search engine along with the queries used to retrieve those results. Assistant will then pick maxiumum 3 of the most relevant search results based on the queries and the content of the search results. Assistant should only pick search results that are relevant to the query and can help in answering the question.
      
      ## Things to taken into consideration when picking the search results:
      1. Relevance to the query: The search results should be relevant to the query provided. Irrelevant results should be ignored.
      2. Content quality: The content of the search results should be of high quality and provide valuable information that can help in answering the question.
      3. Favour known and reputable sources: If there are search results from known and reputable sources that are relevant to the query, those should be prioritized.
      4. Diversity: If there are multiple search results that are relevant and of high quality, try to pick results that provide diverse perspectives or information to get a well-rounded understanding of the topic.
      5. Avoid picking search results that are too similar to each other in terms of content to maximize the amount of information gathered.
      6. Maximum 3 results: Assistant should pick a maximum of 3 search results. If there are more than 3 relevant and high-quality search results, pick the top 3 based on the above criteria. If the queries are very specific and there are only 1 or 2 relevant search results, it's okay to pick only those 1 or 2 results.
      7. Try to pick only one high quality result unless there are diverse perspective in multiple results then you can pick a maximum of 3.
      8. Analyze the title, the snippet and the URL to determine the relevant to query, quality of the content that might be present inside and the reputation of the source before picking the search result.
      
      ## Output format
      Assistant should output an array of indices corresponding to the search results that were picked based on the above criteria. The indices should be based on the order of the search results provided to Assistant. For example, if Assistant picks the 1st, 3rd, and 5th search results, Assistant should output [0, 2, 4].
      
      <example_output>
      {
       "picked_indices": [0,2,4]
      }
      </example_output>
      `;

    /* The picker only has to choose indices, so it needs enough to recognise a
     * result, not the whole object. `JSON.stringify(result)` sent the full
     * scraped content plus metadata -- including the embedding field -- which
     * is how a call whose entire output is `{"picked_indices":[0,2,4]}` came to
     * cost 20,000-24,000 tokens of prefill: six of them took 21 minutes of a
     * 46-minute quality run, 1,273s to emit under 31 characters each. */
    const forPicker = (result: (typeof searchResults)[number]) => ({
      title: result.metadata?.title ?? '',
      url: result.metadata?.url ?? '',
      snippet: (result.content ?? '').slice(0, PICKER_SNIPPET_CHARS),
    });

    const pickerSchema = z.object({
      picked_indices: z
        .array(z.number())
        .describe(
          'The array of the picked indices to be scraped for answering',
        ),
    });

    const pickerResponse = await withRole(
      input.llm,
      'picker',
    ).generateObject<typeof pickerSchema>({
      schema: pickerSchema,
      messages: [
        {
          role: 'system',
          content: pickerPrompt,
        },
        {
          role: 'user',
          content: `<queries>${input.queries.join(', ')}</queries>\n<search_results>${searchResults.map((result, index) => `<result indice=${index}>${JSON.stringify(forPicker(result))}</result>`).join('\n')}</search_results>`,
        },
      ],
    });

    const pickedIndices = pickerResponse.picked_indices.slice(0, 3);
    const pickedResults = pickedIndices
      .map((i) => searchResults[i])
      .filter((r) => r !== undefined);

    const alreadyExtractedURLs: string[] = [];

    researchBlock.data.subSteps.forEach((step) => {
      if (step.type === 'reading') {
        step.reading.forEach((chunk) => {
          alreadyExtractedURLs.push(chunk.metadata.url);
        });
      }
    });

    const filteredResults = pickedResults.filter(
      (r) => !alreadyExtractedURLs.find((url) => url === r.metadata.url),
    );

    if (filteredResults.length > 0) {
      researchBlock.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reading',
        reading: filteredResults.map(toDisplayChunk),
      });

      input.session.updateBlock(researchBlock.id, [
        {
          path: '/data/subSteps',
          op: 'replace',
          value: researchBlock.data.subSteps,
        },
      ]);
    }

    const extractedFacts: Chunk[] = [];



    await Promise.all(
      filteredResults.map(async (result, i) => {
        try {
          patchProgress(input.session, researchBlock.id, (p) => {
            p.phase = 'reading';
            p.scrape.inFlight++;
          });

          let scrapedData;
          try {
            scrapedData = await timeCall(
              input.callContext,
              {
                kind: 'scrape',
                method: 'playwright',
                label: result.metadata.url,
              },
              () =>
                Scraper.scrape(result.metadata.url).catch((err) => {
                  console.log(
                    'Error scraping data from',
                    result.metadata.url,
                    err,
                  );
                }),
              (r) => (r?.ok ? `${r.content.length} chars` : 'failed'),
            );
          } finally {
            patchProgress(
              input.session,
              researchBlock.id,
              (p) => p.scrape.inFlight--,
            );
          }

          patchProgress(input.session, researchBlock.id, (p) => {
            if (scrapedData?.ok) p.scrape.completed++;
            else p.scrape.failed++;
          });

          /* `ok` is false when the page was reached but carried no readable
           * text -- a block page or a JavaScript shell. Same reasoning as the
           * scrape action: that is not a source. */
          if (!scrapedData || !scrapedData.ok) return;

          const extraction = await extractFacts({
            llm: input.llm,
            content: scrapedData.content,
            queries: input.queries,
            session: input.session,
            researchBlockId: researchBlock.id,
            contextPerRequest: input.contextPerRequest,
          });

          /* A page whose every chunk failed has no facts, and citing it would
           * put a source in the answer that nothing was read from -- the same
           * mistake as citing a bot-blocked page. Drop it and say so. */
          if (extraction.chunksTotal > 0 && !extraction.content.trim()) {
            console.error(
              `Extraction produced nothing for ${result.metadata.url}; ` +
                `${extraction.chunksFailed}/${extraction.chunksTotal} chunks failed. Dropping the source.`,
            );
            return;
          }

          if (extraction.chunksFailed > 0) {
            console.error(
              `Partial extraction for ${result.metadata.url}: ` +
                `${extraction.chunksFailed} of ${extraction.chunksTotal} chunks failed.`,
            );
          }

          extractedFacts.push({
            ...result,
            content: extraction.content,
          });
        } catch (err) {
          console.log(
            'Error scraping or extracting information from',
            result.metadata.url,
            err,
          );
        }
      }),
    );

    return extractedFacts;
  } else {
    return [];
  }
};
