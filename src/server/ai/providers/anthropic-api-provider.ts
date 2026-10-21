// ============================================
// ANTHROPIC DIRECT API PROVIDER
// Wraps @anthropic-ai/sdk with the provider interface.
// ============================================

import Anthropic from '@anthropic-ai/sdk';
import {
  toAnthropicMessages,
  toAnthropicTools,
  toAnthropicSystem,
  fromAnthropicResponse,
  convertAnthropicStream,
} from './anthropic-provider';
import type {
  AIProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from './types';

/**
 * Claude over Anthropic's own API, authenticated with an API key.
 *
 * The Bedrock provider this sits beside authenticates through the ambient AWS
 * credential chain, which means it cannot work on a laptop or in a container
 * without AWS access. Since the goal is for this product to run with nothing
 * but `DATABASE_URL` and one API key, this is the default path and Bedrock is
 * opt-in.
 *
 * Every format converter is imported rather than reimplemented — the two SDKs
 * expose the same `messages.create` surface and emit the same event shapes, so
 * the only real differences are the client constructor and the model id
 * namespace (see ANTHROPIC_API_MODELS vs ANTHROPIC_BEDROCK_MODELS in types).
 */
export class AnthropicApiProvider implements AIProvider {
  readonly providerType = 'anthropic' as const;
  readonly displayName = 'Claude (Anthropic API)';
  private client: Anthropic;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Should be unreachable: registration is gated on the key being present.
      // Failing here rather than on first request keeps the error close to
      // the cause.
      throw new Error('AnthropicApiProvider requires ANTHROPIC_API_KEY');
    }
    this.client = new Anthropic({
      apiKey,
      ...(options?.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as never,
      messages: toAnthropicMessages(request.messages) as never,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    } as never);

    return fromAnthropicResponse(response);
  }

  async createStreamingMessage(
    request: ProviderRequest,
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    const stream = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as never,
      messages: toAnthropicMessages(request.messages) as never,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      stream: true,
    } as never);

    return convertAnthropicStream(stream as unknown as AsyncIterable<unknown>);
  }

  async createMessageWithTools(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as never,
      messages: toAnthropicMessages(request.messages) as never,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.tools?.length && { tools: toAnthropicTools(request.tools) as never }),
    } as never);

    return fromAnthropicResponse(response);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  getRawClient(): Anthropic {
    return this.client;
  }
}
