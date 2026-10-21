// ============================================
// OPENAI PROVIDER
// Wraps OpenAI SDK with provider interface
// ============================================

import OpenAI from 'openai';
import type {
  AIProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseBlock,
  ProviderStreamEvent,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
} from './types';

// ============================================
// FORMAT CONVERTERS (provider-agnostic → OpenAI)
// ============================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function toOpenAIMessages(
  messages: ProviderMessage[],
  system?: string | Array<{ type: 'text'; text: string }>
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System message first. OpenAI doesn't take per-block cache_control markers
  // (its caching is automatic on prefix), so collapse the array form into a
  // single concatenated string.
  const systemText =
    typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map((b) => b.text).join('\n\n')
        : '';
  if (systemText) {
    result.push({ role: 'system', content: systemText });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Handle structured content blocks
    const blocks = msg.content as ProviderContentBlock[];
    const textParts: string[] = [];
    const toolUseParts: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    const toolResultParts: Array<{ tool_call_id: string; content: string }> = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseParts.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResultParts.push({
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }

    // Assistant message with tool calls
    if (msg.role === 'assistant' && toolUseParts.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolUseParts,
      });
    } else if (toolResultParts.length > 0) {
      // Tool results become individual tool messages
      for (const tr of toolResultParts) {
        result.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        });
      }
    } else {
      result.push({
        role: msg.role,
        content: textParts.join('\n'),
      });
    }
  }

  return result;
}

function toOpenAITools(
  tools: ProviderTool[]
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function fromOpenAIResponse(response: OpenAI.Chat.Completions.ChatCompletion): ProviderResponse {
  const choice = response.choices[0];
  const content: ProviderResponseBlock[] = [];

  // Text content
  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  // Tool calls
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if ('function' in tc && tc.function) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }
  }

  return {
    content,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    model: response.model,
    stopReason: choice?.finish_reason ?? undefined,
  };
}

// ============================================
// OPENAI PROVIDER
// ============================================

export class OpenAIProvider implements AIProvider {
  readonly providerType = 'openai' as const;
  readonly displayName = 'OpenAI';
  private client: OpenAI;

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: options?.apiKey || process.env.OPENAI_API_KEY,
      ...(options?.baseURL && { baseURL: options.baseURL }),
    });
  }

  async createMessage(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: toOpenAIMessages(request.messages, request.system) as any,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    });

    return fromOpenAIResponse(response);
  }

  async createStreamingMessage(
    request: ProviderRequest
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    const stream = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: toOpenAIMessages(request.messages, request.system) as any,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      stream: true,
      stream_options: { include_usage: true },
    });

    return this.convertOpenAIStream(stream);
  }

  async createMessageWithTools(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      max_tokens: request.maxTokens,
      messages: toOpenAIMessages(request.messages, request.system) as any,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.tools?.length && { tools: toOpenAITools(request.tools) }),
    });

    return fromOpenAIResponse(response);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  private async *convertOpenAIStream(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  ): AsyncIterable<ProviderStreamEvent> {
    let inputTokens = 0;

    yield { type: 'message_start', usage: { inputTokens: 0 } };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: 'content_delta', text: delta.content };
      }

      // Usage comes in the final chunk
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        yield {
          type: 'message_delta',
          usage: { outputTokens: chunk.usage.completion_tokens },
        };
      }

      if (chunk.choices[0]?.finish_reason) {
        yield { type: 'done' };
      }
    }
  }
}
