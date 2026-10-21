// ============================================
// ANTHROPIC BEDROCK PROVIDER
// Wraps @anthropic-ai/bedrock-sdk with provider interface
// ============================================

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import type {
  AIProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseBlock,
  ProviderStreamEvent,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  ProviderSystemBlock,
} from './types';

// ============================================
// FORMAT CONVERTERS (provider-agnostic → Anthropic)
// ============================================

export function toAnthropicMessages(
  messages: ProviderMessage[]
): Array<{ role: 'user' | 'assistant'; content: any }> {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }
    // Convert content blocks
    return {
      role: msg.role,
      content: (msg.content as ProviderContentBlock[]).map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        }
        return block;
      }),
    };
  });
}

export function toAnthropicTools(tools: ProviderTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const out: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      input_schema: { type: 'object' as const, ...t.input_schema },
    };
    if (t.cache_control) out.cache_control = t.cache_control;
    return out;
  });
}

/** Convert our provider-agnostic system field into the shape Anthropic expects.
 * - `string` → passed through as a plain string (no caching).
 * - `ProviderSystemBlock[]` → array of `{type:'text', text, cache_control?}`,
 *   which is the shape the Bedrock SDK forwards verbatim and which lets us
 *   mark a cache breakpoint on the static prefix. */
export function toAnthropicSystem(
  system: string | ProviderSystemBlock[] | undefined
): string | Array<Record<string, unknown>> | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.map((b) => {
    const out: Record<string, unknown> = { type: 'text', text: b.text };
    if (b.cache_control) out.cache_control = b.cache_control;
    return out;
  });
}

export function fromAnthropicResponse(response: any): ProviderResponse {
  const content: ProviderResponseBlock[] = response.content.map((block: any) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use' as const,
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    return block;
  });

  return {
    content,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
    },
    model: response.model,
    stopReason: response.stop_reason,
  };
}

// ============================================
// ANTHROPIC BEDROCK PROVIDER
// ============================================

export class AnthropicBedrockProvider implements AIProvider {
  readonly providerType = 'anthropic-bedrock' as const;
  readonly displayName = 'Claude (AWS Bedrock)';
  private client: AnthropicBedrock;

  constructor(options?: { awsRegion?: string }) {
    const awsRegion = options?.awsRegion || 'ap-south-1';
    this.client = new AnthropicBedrock({ awsRegion });
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as any,
      messages: toAnthropicMessages(request.messages),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    } as any);

    return fromAnthropicResponse(response);
  }

  async createStreamingMessage(
    request: ProviderRequest
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    const stream = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as any,
      messages: toAnthropicMessages(request.messages),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      stream: true,
    } as any);

    return convertAnthropicStream(stream as unknown as AsyncIterable<any>);
  }

  async createMessageWithTools(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system) as any,
      messages: toAnthropicMessages(request.messages),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.tools?.length && { tools: toAnthropicTools(request.tools) as any }),
    } as any);

    return fromAnthropicResponse(response);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  // Raw client access for edge cases that need direct Bedrock SDK
  getRawClient(): AnthropicBedrock {
    return this.client;
  }

}

/**
 * Anthropic wire-format stream -> our provider-agnostic events.
 *
 * Module level rather than a private method: the Bedrock SDK and the direct
 * SDK emit byte-identical event shapes, so both providers share this.
 */
export async function* convertAnthropicStream(
  stream: AsyncIterable<any>
): AsyncIterable<ProviderStreamEvent> {
  for await (const event of stream) {
    if (event.type === 'message_start') {
      yield {
        type: 'message_start',
        usage: event.message?.usage
          ? {
              inputTokens: event.message.usage.input_tokens,
              cacheCreationInputTokens: event.message.usage.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: event.message.usage.cache_read_input_tokens ?? 0,
            }
          : undefined,
      };
    } else if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta'
    ) {
      yield { type: 'content_delta', text: event.delta.text };
    } else if (event.type === 'message_delta') {
      yield {
        type: 'message_delta',
        usage: event.usage
          ? { outputTokens: event.usage.output_tokens }
          : undefined,
      };
    } else if (event.type === 'message_stop') {
      yield { type: 'done' };
    }
  }
}
