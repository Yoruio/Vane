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
  async isModelLoaded(modelName: string): Promise<boolean> {
    try {
      const res = await fetch(this.managementURL('/health'), {
        headers: this.managementHeaders(),
      });

      if (!res.ok) return false;

      const health = await res.json();

      return (health.all_models_loaded ?? []).some(
        (m: any) => m.model_name === modelName && m.loaded,
      );
    } catch {
      /* An unreachable management API is not a reason to block a search. */
      return false;
    }
  }

  async loadModel(modelName: string): Promise<boolean> {
    try {
      const res = await fetch(this.managementURL('/load'), {
        method: 'POST',
        headers: this.managementHeaders(),
        body: JSON.stringify({ model_name: modelName }),
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

    return {
      baseURL: String(raw.baseURL),
      apiKey: raw.apiKey ? String(raw.apiKey) : undefined,
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
