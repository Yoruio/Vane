import z from 'zod';
import { withRole } from '@/lib/models/base/instrumented';
import { splitScrapedContent } from './chunking';
import { patchProgress } from './progress';
import type BaseLLM from '@/lib/models/base/llm';
import type SessionManager from '@/lib/session';

/* One copy of the extractor. Both callers -- the orchestrator's scrape_url tool
 * and the quality-mode search action -- had their own byte-identical prompt,
 * schema and chunk loop, and differed only in how they handled failure. Which
 * meant a fix had to be written twice and, in practice, was written once. */
const extractorPrompt = `
                  Assistant is an AI information extractor. Assistant will be shared with scraped information from a website along with the queries used to retrieve that information. Assistant's task is to extract relevant facts from the scraped data to answer the queries.
            
                  ## Things to taken into consideration when extracting information:
                  1. Relevance to the query: The extracted information must dynamically adjust based on the query's intent. If the query asks "What is [X]", you must extract the definition/identity. If the query asks for "[X] specs" or "features", you must provide deep, granular technical details.
                     - Example: For "What is [Product]", extract the core definition. For "[Product] capabilities", extract every technical function mentioned.
                  2. Concentrate on extracting factual information that can help in answering the question rather than opinions or commentary. Ignore marketing fluff like "best-in-class" or "seamless."
                  3. Noise to signal ratio: If the scraped data is noisy (headers, footers, UI text), ignore it and extract only the high-value information. 
                     - Example: Discard "Click for more" or "Subscribe now" messages.
                  4. Avoid using filler sentences or words; extract concise, telegram-style information.
                     - Example: Change "The device features a weight of only 1.2kg" to "Weight: 1.2kg."
                  5. Duplicate information: If a fact appears multiple times (e.g., in a paragraph and a technical table), merge the details into a single, high-density bullet point to avoid redundancy.
                  6. Numerical Data Integrity: NEVER summarize or generalize numbers, benchmarks, or table data. Extract raw values exactly as they appear.
                     - Example: Do not say "Improved coding scores." Say "LiveCodeBench v6: 80.0%."
            
                  ## Example
                  For example, if the query is "What are the health benefits of green tea?" and the scraped data contains various pieces of information about green tea, Assistant should focus on extracting factual information related to the health benefits of green tea such as "Green tea contains antioxidants which can help in reducing inflammation" and ignore irrelevant information such as "Green tea is a popular beverage worldwide".
                  
                  It can also remove filler words to reduce the sentence to "Contains antioxidants; reduces inflammation." 
                  
                  For tables/numerical data extraction, Assistant should extract the raw numerical data or the content of the table without trying to summarize it to avoid losing important details. For example, if a table lists specific battery life hours for different modes, Assistant should list every mode and its corresponding hour count rather than giving a general average.
                  
                  Make sure the extracted facts are in bullet points format to make it easier to read and understand.
            
                  ## Output format
                  Assistant should reply with a JSON object containing a key "extracted_facts" which is a string of the bulleted facts. Return only raw JSON without markdown formatting (no \`\`\`json blocks).
            
                  <example_output>
                  {
                    "extracted_facts": "- Fact 1\n- Fact 2\n- Fact 3"
                  }
                  </example_output>
                  `;

const extractorSchema = z.object({
  extracted_facts: z
    .string()
    .describe(
      'The extracted facts that are relevant to the query and can help in answering the question should be listed here in a concise manner.',
    ),
});

export type ExtractionResult = {
  /* The facts, or raw chunk text when everything failed and the caller asked
   * for that fallback. Empty when nothing could be extracted. */
  content: string;
  chunksTotal: number;
  chunksFailed: number;
  /* True when content is unextracted page text rather than facts. */
  rawFallback: boolean;
};

/**
 * Splits a scraped page and reduces each chunk to facts.
 *
 * Returns how many chunks failed instead of hiding it. The previous behaviour
 * logged each failure to stdout and carried on, so a page whose extraction
 * partly crashed was indistinguishable from a page that simply had little to
 * say -- and the model errors that caused it (llama.cpp grammar crashes, which
 * Lemonade reports properly as HTTP 500) never reached the UI or the caller.
 */
export const extractFacts = async ({
  llm,
  content,
  queries,
  session,
  researchBlockId,
  contextPerRequest,
  fallbackToRaw = false,
}: {
  llm: BaseLLM<any>;
  content: string;
  queries: string[];
  session: SessionManager;
  researchBlockId: string;
  contextPerRequest?: number;
  /* When every chunk fails, hand back the first raw chunk rather than nothing.
   * The scrape_url tool prefers that to returning an empty source; the search
   * action prefers to drop the source entirely. */
  fallbackToRaw?: boolean;
}): Promise<ExtractionResult> => {
  const chunks = splitScrapedContent(content, contextPerRequest);

  patchProgress(
    session,
    researchBlockId,
    (p) => (p.scrape.chunksTotal += chunks.length),
  );

  let accumulated = '';
  let failed = 0;

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const extracted = await withRole(llm, 'extractor').generateObject<
          typeof extractorSchema
        >({
          schema: extractorSchema,
          messages: [
            { role: 'system', content: extractorPrompt },
            {
              role: 'user',
              content: `<queries>${queries.join(', ')}</queries>\n<scraped_data>${chunk}</scraped_data>`,
            },
          ],
        });

        accumulated += extracted.extracted_facts + '\n';

        patchProgress(session, researchBlockId, (p) => p.scrape.chunksDone++);
      } catch (err) {
        failed += 1;

        /* Logged with the reason, and counted into the research block so the
         * run can say "2 of 3 chunks failed" instead of silently thinning. */
        console.error(
          `Extractor failed on one chunk (${failed}/${chunks.length} so far):`,
          err instanceof Error ? err.message : err,
        );

        patchProgress(session, researchBlockId, (p) => p.scrape.chunksFailed++);
      }
    }),
  );

  const everythingFailed = failed === chunks.length && chunks.length > 0;

  if (everythingFailed && fallbackToRaw) {
    return {
      content: chunks[0],
      chunksTotal: chunks.length,
      chunksFailed: failed,
      rawFallback: true,
    };
  }

  return {
    content: accumulated,
    chunksTotal: chunks.length,
    chunksFailed: failed,
    rawFallback: false,
  };
};
