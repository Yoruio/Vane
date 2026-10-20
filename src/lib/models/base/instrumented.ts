import z from 'zod';
import BaseLLM from './llm';
import db from '@/lib/db';
import { llmCalls } from '@/lib/db/schema';
import {
  GenerateObjectInput,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
} from '../types';

export type LLMCallContext = {
  messageId?: string;
  chatId?: string;
  provider?: string;
  model?: string;
  /** Persist the full prompt and response. Off by default: a single search can
   *  make hundreds of calls with ~4000-token prompts. */
  captureText?: boolean;
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

  private begin(method: string, inputText: string): Pending {
    return {
      method,
      startedAt: new Date().toISOString(),
      start: Date.now(),
      inputText,
    };
  }

  private async finish(p: Pending, outputText: string, error?: unknown) {
    try {
      await db.insert(llmCalls).values({
        messageId: this.ctx.messageId,
        chatId: this.ctx.chatId,
        provider: this.ctx.provider,
        model: this.ctx.model,
        method: p.method,
        startedAt: p.startedAt,
        durationMs: Date.now() - p.start,
        firstChunkMs: p.firstChunkMs,
        inputChars: p.inputText.length,
        outputChars: outputText.length,
        inputText: this.ctx.captureText ? p.inputText : null,
        outputText: this.ctx.captureText ? outputText : null,
        error:
          error === undefined
            ? null
            : error instanceof Error
              ? error.message
              : String(error),
      });
    } catch (err) {
      // Telemetry must never break a search.
      console.error('Failed to record llm call:', err);
    }
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const p = this.begin('generateText', serializeMessages(input.messages));
    try {
      const out = await this.inner.generateText(input);
      await this.finish(p, out.content ?? '');
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
    try {
      for await (const chunk of this.inner.streamText(input)) {
        if (p.firstChunkMs === undefined) p.firstChunkMs = Date.now() - p.start;
        output += chunk.contentChunk ?? '';
        yield chunk;
      }
      await this.finish(p, output);
    } catch (err) {
      await this.finish(p, output, err);
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

export default InstrumentedLLM;
