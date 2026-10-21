import type {
  AIProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from './types';

/**
 * Error thrown when no AI provider is configured.
 *
 * The find-leads pipeline classifies failures by inspecting the message, and
 * maps anything mentioning anthropic/claude/bedrock to the `ai_unavailable`
 * error code. This message is worded to land in that bucket deliberately, so
 * the UI shows "we couldn't reach the AI" rather than a generic internal
 * error.
 */
export class NoAIProviderError extends Error {
  readonly code = 'AI_UNAVAILABLE';
  constructor() {
    super(
      'No AI provider is configured. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY, ' +
        'or AI_BEDROCK_ENABLED=true with AWS credentials) to enable Claude.',
    );
    this.name = 'NoAIProviderError';
  }
}

/**
 * Registered only when nothing else is.
 *
 * Without this, the router would have zero providers and callers would get an
 * opaque "no provider available" from deep inside the routing logic. And a
 * provider registered without its credentials is worse still: with no AWS
 * credentials, every Bedrock request spends ~30s in the credential chain
 * before failing, and burns the health tracker's failure budget on the way.
 *
 * Failing immediately with a message that names the fix is strictly better.
 */
export class NullProvider implements AIProvider {
  readonly providerType = 'null' as const;
  readonly displayName = 'No provider configured';

  async createMessage(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new NoAIProviderError();
  }

  async createStreamingMessage(
    _request: ProviderRequest,
  ): Promise<AsyncIterable<ProviderStreamEvent>> {
    throw new NoAIProviderError();
  }

  async createMessageWithTools(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new NoAIProviderError();
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}
