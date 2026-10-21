// ============================================
// AI PROVIDERS — PUBLIC API
// ============================================

export type {
  AIProvider,
  AIProviderType,
  ProviderConfig,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseBlock,
  ProviderStreamEvent,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  ModelTier,
  ProviderModelMap,
} from './types';

export {
  DEFAULT_PROVIDER_CONFIG,
  ANTHROPIC_API_MODELS,
  ANTHROPIC_BEDROCK_MODELS,
  OPENAI_MODELS,
  getEquivalentModel,
} from './types';

export { AnthropicApiProvider } from './anthropic-api-provider';
export { OpenAIProvider } from './openai-provider';
export { NullProvider, NoAIProviderError } from './null-provider';
export { ProviderRouter } from './provider-router';

// ============================================
// SINGLETON ROUTER INSTANCE
// ============================================

import { ProviderRouter } from './provider-router';
import { AnthropicApiProvider } from './anthropic-api-provider';
import { OpenAIProvider } from './openai-provider';
import { NullProvider } from './null-provider';
import type { AIProvider, AIProviderType, ProviderConfig } from './types';

let routerInstance: ProviderRouter | null = null;

/**
 * Get the singleton provider router.
 *
 * Registration is conditional on configuration. Registering Bedrock
 * unconditionally would give an environment without AWS credentials a
 * provider that fails every call: roughly thirty seconds lost in the
 * credential chain, a consumed slot in the health tracker's failure budget,
 * and an error indistinguishable from a genuine outage.
 *
 * Bedrock is opt-in via AI_BEDROCK_ENABLED, and is loaded lazily so its
 * SDK can stay an optional dependency.
 *
 * Priority order: Anthropic direct API, then OpenAI, then Bedrock.
 */
export function getProviderRouter(config?: Partial<ProviderConfig>): ProviderRouter {
  if (routerInstance) return routerInstance;

  const router = new ProviderRouter(config);
  const registered: AIProviderType[] = [];

  const register = (provider: AIProvider) => {
    router.registerProvider(provider);
    registered.push(provider.providerType);
  };

  if (process.env.ANTHROPIC_API_KEY) {
    register(new AnthropicApiProvider());
  }

  if (process.env.OPENAI_API_KEY) {
    register(new OpenAIProvider());
  }

  if (process.env.AI_BEDROCK_ENABLED === 'true') {
    try {
      const mod = require('./anthropic-provider') as typeof import('./anthropic-provider');
      register(new mod.AnthropicBedrockProvider({ awsRegion: process.env.AI_BEDROCK_REGION }));
    } catch (err) {
      console.warn(
        '[ai] AI_BEDROCK_ENABLED=true but the Bedrock provider could not be loaded:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (registered.length === 0) {
    register(new NullProvider());
    console.warn(
      '[ai] No AI provider configured. Lead extraction will fail fast with ai_unavailable. Set ANTHROPIC_API_KEY.',
    );
  } else {
    console.log('[ai] providers registered:', registered.join(', '));
  }

  // Registration order encodes the priority above, so the first entry is the
  // preferred primary and the second is the natural fallback.
  //
  // The `else` branch matters. DEFAULT_PROVIDER_CONFIG names a fallback that
  // may never have been registered, and leaving it set means a failing primary
  // routes to a provider that does not exist — the router then throws
  // "Fallback provider X is not registered", burying the real error. That is
  // exactly how a missing ANTHROPIC_API_KEY surfaced as a generic `internal`
  // failure instead of the actionable `ai_unavailable`.
  router.setPrimaryProvider(registered[0]);
  router.setFallbackProvider(registered.length > 1 ? registered[1] : undefined);

  // Explicit env overrides win, but only for providers that actually exist.
  const envPrimary = process.env.AI_PRIMARY_PROVIDER as AIProviderType | undefined;
  const envFallback = process.env.AI_FALLBACK_PROVIDER as AIProviderType | undefined;
  if (envPrimary && router.getProvider(envPrimary)) {
    router.setPrimaryProvider(envPrimary);
  }
  if (envFallback && router.getProvider(envFallback)) {
    router.setFallbackProvider(envFallback);
  }

  routerInstance = router;
  return routerInstance;
}

/** Reset the singleton (tests, or after changing configuration). */
export function resetProviderRouter(): void {
  routerInstance = null;
}

/** Which providers are live right now. Surfaced by /api/health/ai. */
export function registeredProviders(): AIProviderType[] {
  return getProviderRouter().getRegisteredProviders();
}
