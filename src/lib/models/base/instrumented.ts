import z from 'zod';
import BaseLLM from './llm';
import { CallContext, recordCall } from '@/lib/telemetry';
import {
  GenerateObjectInput,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../types';

export type LLMCallContext = CallContext & {
  provider?: string;
  model?: string;
  role?: string;
};
type Pending = {
  method: string;
  startedAt: string;
  start: number;
  firstChunkMs?: number;
  inputText: string;
};

const serializeMessages = (messages: { role: string; content: string }[]) =>
  messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n');

/* An orchestrator call answers entirely in tool calls, so recording only the
 * content would log it as having returned nothing. */
const serializeToolCalls = (toolCalls: ToolCall[]) =>
  toolCalls
    .map((tc) => `[tool] ${tc.name}(${JSON.stringify(tc.arguments ?? {})})`)
    .join('\n');

const serializeOutput = (content: string, toolCalls: ToolCall[]) =>
  [content, serializeToolCalls(toolCalls)].filter(Boolean).join('\n');

/**
 * Wraps a BaseLLM and records one row per call. Implemented as a decorator so
 * no provider has to be modified: the registry wraps whatever it loads, and
 * every provider is covered including ones added later.
 *
 * Recording never affects the call itself — a telemetry failure is logged and
 * swallowed, and errors from the underlying model are recorded then rethrown.
 */
class InstrumentedLLM<CONFIG> extends BaseLLM<CONFIG> {
  constructor(
    private inner: BaseLLM<CONFIG>,
    private ctx: LLMCallContext,
  ) {
    // The wrapper holds no config of its own; `inner` owns it.
    super(undefined as unknown as CONFIG);
  }

  /* Returns a wrapper around the same underlying model that tags its rows with
   * a role. Cheap -- no provider state is copied -- so call sites can do it
   * inline per call. */
  withRole(role: string): InstrumentedLLM<CONFIG> {
    return new InstrumentedLLM(this.inner, { ...this.ctx, role });
  }

  private begin(method: string, inputText: string): Pending {
    return {
      method,
      startedAt: new Date().toISOString(),
      start: Date.now(),
      inputText,
    };
  }

  private async finish(p: Pending, outputText: string, error?: unknown) {
    await recordCall(this.ctx, {
      kind: 'model',
      method: p.method,
      role: this.ctx.role,
      provider: this.ctx.provider,
      model: this.ctx.model,
      startedAt: p.startedAt,
      durationMs: Date.now() - p.start,
      firstChunkMs: p.firstChunkMs,
      inputText: p.inputText,
      outputText,
      error,
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const p = this.begin('generateText', serializeMessages(input.messages));
    try {
      const out = await this.inner.generateText(input);
      await this.finish(p, serializeOutput(out.content ?? '', out.toolCalls));
      return out;
    } catch (err) {
      await this.finish(p, '', err);
      throw err;
    }
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const p = this.begin('streamText', serializeMessages(input.messages));
    let output = '';
    /* Each chunk carries the whole accumulated state of the tool calls it
     * touches, not a delta, so keep the latest per call rather than appending. */
    const toolCalls = new Map<string, ToolCall>();

    try {
      for await (const chunk of this.inner.streamText(input)) {
        if (p.firstChunkMs === undefined) p.firstChunkMs = Date.now() - p.start;
        output += chunk.contentChunk ?? '';
        chunk.toolCallChunk?.forEach((tc, index) =>
          toolCalls.set(tc.id || tc.name || String(index), tc),
        );
        yield chunk;
      }
      await this.finish(p, serializeOutput(output, [...toolCalls.values()]));
    } catch (err) {
      await this.finish(
        p,
        serializeOutput(output, [...toolCalls.values()]),
        err,
      );
      throw err;
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<z.infer<T>> {
    const p = this.begin('generateObject', serializeMessages(input.messages));
    try {
      const out = await this.inner.generateObject<T>(input);
      await this.finish(p, JSON.stringify(out ?? ''));
      return out;
    } catch (err) {
      await this.finish(p, '', err);
      throw err;
    }
  }

  async *streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<z.infer<T>>> {
    const p = this.begin('streamObject', serializeMessages(input.messages));
    let last: unknown = undefined;
    try {
      for await (const chunk of this.inner.streamObject<T>(input)) {
        if (p.firstChunkMs === undefined) p.firstChunkMs = Date.now() - p.start;
        last = chunk;
        yield chunk;
      }
      await this.finish(p, JSON.stringify(last ?? ''));
    } catch (err) {
      await this.finish(p, JSON.stringify(last ?? ''), err);
      throw err;
    }
  }
}

/**
 * Tags a model's telemetry with the job it is doing. A no-op when the model is
 * not instrumented, so call sites need no conditional.
 */
export const withRole = <T extends BaseLLM<any>>(llm: T, role: string): T =>
  llm instanceof InstrumentedLLM ? (llm.withRole(role) as unknown as T) : llm;

export default InstrumentedLLM;
