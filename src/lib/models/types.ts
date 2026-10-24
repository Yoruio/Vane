import z from 'zod';
import { Message } from '../types';

type Model = {
  name: string;
  key: string;
};

type ModelList = {
  embedding: Model[];
  chat: Model[];
};

type ProviderMetadata = {
  name: string;
  key: string;
};

type MinimalProvider = {
  id: string;
  name: string;
  chatModels: Model[];
  embeddingModels: Model[];
};

type ModelWithProvider = {
  key: string;
  providerId: string;
};

type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  /* Ask a reasoning model to answer without thinking first. Honoured only by
   * providers that can express it -- a hosted API has no chat template to
   * parameterise -- so it is a hint, not a guarantee. */
  disableThinking?: boolean;
};

type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
};

type GenerateTextInput = {
  messages: Message[];
  tools?: Tool[];
  options?: GenerateOptions;
};

type GenerateTextOutput = {
  content: string;
  toolCalls: ToolCall[];
  additionalInfo?: Record<string, any>;
};

type StreamTextOutput = {
  contentChunk: string;
  toolCallChunk: ToolCall[];
  additionalInfo?: Record<string, any>;
  done?: boolean;
};

type GenerateObjectInput = {
  schema: z.ZodTypeAny;
  messages: Message[];
  options?: GenerateOptions;
};

type GenerateObjectOutput<T> = {
  object: T;
  additionalInfo?: Record<string, any>;
};

type StreamObjectOutput<T> = {
  objectChunk: Partial<T>;
  additionalInfo?: Record<string, any>;
  done?: boolean;
};

export type {
  Model,
  ModelList,
  ProviderMetadata,
  MinimalProvider,
  ModelWithProvider,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  GenerateObjectInput,
  GenerateObjectOutput,
  StreamObjectOutput,
  Tool,
  ToolCall,
};
