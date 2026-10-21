import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import BaseModelProvider from '../../base/provider';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseLLM from '../../base/llm';
import LemonadeLLM from './lemonadeLLM';
import BaseEmbedding from '../../base/embedding';
import LemonadeEmbedding from './lemonadeEmbedding';

interface LemonadeConfig {
  baseURL: string;
  apiKey?: string;
  llamacppArgs?: string;
}

const providerConfigFields: UIConfigField[] = [
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description: 'The base URL for Lemonade API',
    required: true,
    placeholder: 'https://api.lemonade.ai/v1',
    env: 'LEMONADE_BASE_URL',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'llama.cpp arguments',
    key: 'llamacppArgs',
    description:
      'Passed to llama-server when this app loads a model, overriding the server default. "--parallel 4" lets concurrent requests share a batch, which on bandwidth-bound hardware roughly doubles throughput when a search runs several extractions at once; it also divides the context window between slots. Leave empty to use whatever the server is configured with.',
    required: false,
    placeholder: '--parallel 4',
    env: 'LEMONADE_LLAMACPP_ARGS',
    scope: 'server',
  },
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description: 'Your Lemonade API key (optional)',
    required: false,
    placeholder: 'Lemonade API Key',
    env: 'LEMONADE_API_KEY',
    scope: 'server',
  },
];

class LemonadeProvider extends BaseModelProvider<LemonadeConfig> {
  constructor(id: string, name: string, config: LemonadeConfig) {
    super(id, name, config);
  }

  /* Lemonade's management API sits beside the OpenAI-compatible path: the
   * configured baseURL ends in /v1, the management routes are under /api/v1. */
  private managementURL(path: string) {
    return `${this.config.baseURL.replace(/\/v1\/?$/, '')}/api/v1${path}`;
  }

  private managementHeaders() {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey
        ? { Authorization: `Bearer ${this.config.apiKey}` }
        : {}),
    };
  }

  /**
   * Whether the weights are already resident. Lemonade unloads idle models, and
   * the first request after that pays ~26s of load -- which otherwise lands on
   * whichever call happens to be first.
   */
  private async loadedRecord(modelName: string): Promise<any | null> {
    try {
      const res = await fetch(this.managementURL('/health'), {
        headers: this.managementHeaders(),
      });

      if (!res.ok) return null;

      const health = await res.json();

      return (
        (health.all_models_loaded ?? []).find(
          (m: any) => m.model_name === modelName && m.loaded,
        ) ?? null
      );
    } catch {
      /* An unreachable management API is not a reason to block a search. */
      return null;
    }
  }

  async isModelLoaded(modelName: string): Promise<boolean> {
    const record = await this.loadedRecord(modelName);

    if (!record) return false;

    /* Resident but launched with different arguments counts as not ready, or
     * configuring them here would silently do nothing whenever the model
     * happened to already be up. */
    if (
      this.config.llamacppArgs &&
      record.recipe_options?.llamacpp_args !== this.config.llamacppArgs
    ) {
      return false;
    }

    return true;
  }

  async loadModel(modelName: string): Promise<boolean> {
    try {
      /* llama-server only takes its arguments at process start, so applying
       * them to a resident model means restarting it. Never do that while it is
       * serving someone -- another client may share this box. */
      const record = await this.loadedRecord(modelName);

      if (record && !record.is_busy && !record.is_streaming) {
        await fetch(this.managementURL('/unload'), {
          method: 'POST',
          headers: this.managementHeaders(),
          body: JSON.stringify({ model_name: modelName }),
        }).catch(() => undefined);
      } else if (record) {
        /* Busy: leave it alone and report the current state as good enough. */
        return true;
      }

      const res = await fetch(this.managementURL('/load'), {
        method: 'POST',
        headers: this.managementHeaders(),
        body: JSON.stringify({
          model_name: modelName,
          /* Only sent when configured, so the server keeps its own defaults
           * otherwise. Note the load endpoint reports success even for keys it
           * ignores, so check /health to confirm it took effect. */
          ...(this.config.llamacppArgs
            ? { llamacpp_args: this.config.llamacppArgs }
            : {}),
        }),
      });

      if (!res.ok) return false;

      const data = await res.json();

      return data.status === 'success';
    } catch {
      return false;
    }
  }

  async getDefaultModels(): Promise<ModelList> {
    try {
      const res = await fetch(`${this.config.baseURL}/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
      });

      const data = await res.json();

      const models: Model[] = data.data
        .filter((m: any) => m.recipe === 'llamacpp')
        .map((m: any) => {
          return {
            name: m.id,
            key: m.id,
          };
        });

      return {
        embedding: models,
        chat: models,
      };
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(
          'Error connecting to Lemonade API. Please ensure the base URL is correct and the service is available.',
        );
      }

      throw err;
    }
  }

  async getModelList(): Promise<ModelList> {
    const defaultModels = await this.getDefaultModels();
    const configProvider = getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading Lemonade Chat Model. Invalid Model Selected',
      );
    }

    return new LemonadeLLM({
      apiKey: this.config.apiKey || 'not-needed',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading Lemonade Embedding Model. Invalid Model Selected.',
      );
    }

    return new LemonadeEmbedding({
      apiKey: this.config.apiKey || 'not-needed',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  static parseAndValidate(raw: any): LemonadeConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.baseURL)
      throw new Error('Invalid config provided. Base URL must be provided');

    /* Every key the provider needs has to be listed here: this builds the
     * config object rather than spreading raw, so anything omitted is silently
     * dropped before the instance sees it. */
    return {
      baseURL: String(raw.baseURL),
      apiKey: raw.apiKey ? String(raw.apiKey) : undefined,
      llamacppArgs: raw.llamacppArgs ? String(raw.llamacppArgs) : undefined,
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'lemonade',
      name: 'Lemonade',
    };
  }
}

export default LemonadeProvider;
