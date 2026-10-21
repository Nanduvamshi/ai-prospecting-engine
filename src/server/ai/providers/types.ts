// ============================================
// AI PROVIDER ABSTRACTION TYPES
// Provider-agnostic interface for multi-LLM support
// ============================================

// ============================================
// PROVIDER IDENTITY
// ============================================

export type AIProviderType = 'anthropic' | 'anthropic-bedrock' | 'openai' | 'null';

export interface ProviderInfo {
  type: AIProviderType;
  name: string;
  isAvailable: boolean;
  lastHealthCheck?: number;
  consecutiveFailures: number;
}

// ============================================
// PROVIDER REQUEST / RESPONSE
// ============================================

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string | ProviderContentBlock[];
}

export type ProviderContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: string; data: string };
      title?: string;
    };

export interface ProviderTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Marks this tool as the cache breakpoint for the tools array.
   * Place on the LAST tool in the static set so the entire tools list
   * (plus everything before it) is cached for re-use across turns. */
  cache_control?: { type: 'ephemeral' };
}

/** A system-prompt block. Use the array form to declare a cache breakpoint
 * via `cache_control: { type: 'ephemeral' }` on a static prefix block. */
export type ProviderSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

export interface ProviderRequest {
  model: string;
  maxTokens: number;
  /** Either a plain string, or an array of system blocks where one or more
   * blocks carry `cache_control` to enable Anthropic prompt caching. */
  system?: string | ProviderSystemBlock[];
  messages: ProviderMessage[];
  temperature?: number;
  tools?: ProviderTool[];
}

export interface ProviderResponse {
  content: ProviderResponseBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  model: string;
  stopReason?: string;
}

export type ProviderResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

// ============================================
// STREAMING TYPES
// ============================================

export type ProviderStreamEvent =
  | {
      type: 'message_start';
      usage?: {
        inputTokens: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    }
  | { type: 'content_delta'; text: string }
  | { type: 'message_delta'; usage?: { outputTokens: number } }
  | { type: 'done' };

// ============================================
// PROVIDER INTERFACE
// ============================================

export interface AIProvider {
  readonly providerType: AIProviderType;
  readonly displayName: string;

  /** Create a message (non-streaming) */
  createMessage(request: ProviderRequest): Promise<ProviderResponse>;

  /** Create a streaming message */
  createStreamingMessage(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamEvent>>;

  /** Create a message with tool use support */
  createMessageWithTools(request: ProviderRequest): Promise<ProviderResponse>;

  /** Check if the provider is reachable and configured */
  healthCheck(): Promise<boolean>;
}

// ============================================
// PROVIDER ROUTER CONFIG
// ============================================

export interface ProviderConfig {
  primaryProvider: AIProviderType;
  fallbackProvider?: AIProviderType;
  enableAutoFallback: boolean;
  maxRetriesBeforeFallback: number;
  healthCheckIntervalMs: number;
  /** Cooldown before retrying a failed provider (ms) */
  failedProviderCooldownMs: number;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  primaryProvider: 'anthropic-bedrock',
  fallbackProvider: 'openai',
  enableAutoFallback: true,
  maxRetriesBeforeFallback: 2,
  healthCheckIntervalMs: 60_000,
  failedProviderCooldownMs: 30_000,
};

// ============================================
// MODEL MAPPING
// ============================================

/** Maps provider-agnostic model tiers to provider-specific model IDs */
export type ModelTier = 'fast' | 'standard' | 'advanced';

export interface ProviderModelMap {
  provider: AIProviderType;
  models: Record<ModelTier, string>;
  allModels: string[];
}

/**
 * Anthropic's direct API.
 *
 * Same models as the Bedrock map below, different id namespace: Bedrock uses
 * regional inference-profile ids (`global.anthropic.…-v1:0`), the direct API
 * uses plain names. A mismatch surfaces as a ValidationException that looks
 * identical to "no credentials", so keep these two maps in step.
 */
export const ANTHROPIC_API_MODELS: ProviderModelMap = {
  provider: 'anthropic',
  models: {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-5-20250929',
    advanced: 'claude-opus-4-5-20251101',
  },
  allModels: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ],
};

export const ANTHROPIC_BEDROCK_MODELS: ProviderModelMap = {
  provider: 'anthropic-bedrock',
  models: {
    fast: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    standard: 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0',
    advanced: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  },
  allModels: [
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'apac.anthropic.claude-3-haiku-20240307-v1:0',
    'claude-haiku-4-5-20251001',
    'claude-3-haiku-20240307',
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'global.anthropic.claude-sonnet-4-6',
    'apac.anthropic.claude-sonnet-4-20250514-v1:0',
    'apac.anthropic.claude-3-7-sonnet-20250219-v1:0',
    'apac.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
  ],
};

export const OPENAI_MODELS: ProviderModelMap = {
  provider: 'openai',
  models: {
    fast: 'gpt-4o-mini',
    standard: 'gpt-4o',
    advanced: 'gpt-4o',
  },
  allModels: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'o3-mini',
  ],
};

/** Get the equivalent model on a different provider */
export function getEquivalentModel(
  sourceModel: string,
  targetProvider: AIProviderType
): string {
  // All three namespaces are searched, because a model id can arrive in any
  // of them. This matters: the find-leads pipeline names a Bedrock inference
  // profile ("global.anthropic.claude-haiku-...-v1:0"), and sending that id
  // verbatim to the direct API fails with a ValidationException that looks
  // exactly like a missing credential. Mapping by tier avoids that.
  const sourceMaps = [ANTHROPIC_API_MODELS, ANTHROPIC_BEDROCK_MODELS, OPENAI_MODELS];
  const targetMap =
    targetProvider === 'openai'
      ? OPENAI_MODELS
      : targetProvider === 'anthropic-bedrock'
        ? ANTHROPIC_BEDROCK_MODELS
        : ANTHROPIC_API_MODELS;

  // Find which tier this model belongs to in its source provider
  for (const map of sourceMaps) {
    for (const [tier, modelId] of Object.entries(map.models)) {
      if (modelId === sourceModel) {
        return targetMap.models[tier as ModelTier];
      }
    }
    // Check if it's in the allModels list — map by cost tier heuristic
    if (map.allModels.includes(sourceModel)) {
      const lower = sourceModel.toLowerCase();
      if (lower.includes('haiku') || lower.includes('mini')) {
        return targetMap.models.fast;
      }
      if (lower.includes('opus') || lower.includes('gpt-4-turbo') || lower.includes('o3')) {
        return targetMap.models.advanced;
      }
      return targetMap.models.standard;
    }
  }

  // Default fallback — standard tier
  return targetMap.models.standard;
}
