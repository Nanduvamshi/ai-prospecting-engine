// ============================================
// PROVIDER ROUTER
// Auto-fallback, health tracking, and provider selection
// ============================================

import type {
  AIProvider,
  AIProviderType,
  ProviderConfig,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from './types';
import {
  DEFAULT_PROVIDER_CONFIG,
  getEquivalentModel,
  ANTHROPIC_BEDROCK_MODELS,
  OPENAI_MODELS,
} from './types';
import { AIError } from '../errors';

// ============================================
// PROVIDER HEALTH STATE
// ============================================

interface ProviderHealthState {
  isHealthy: boolean;
  consecutiveFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  lastHealthCheckTime: number;
  totalRequests: number;
  totalFailures: number;
}

// ============================================
// PROVIDER ROUTER CLASS
// ============================================

export class ProviderRouter {
  private providers: Map<AIProviderType, AIProvider> = new Map();
  private healthStates: Map<AIProviderType, ProviderHealthState> = new Map();
  private config: ProviderConfig;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = { ...DEFAULT_PROVIDER_CONFIG, ...config };
  }

  // ============================================
  // PROVIDER REGISTRATION
  // ============================================

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.providerType, provider);
    this.healthStates.set(provider.providerType, {
      isHealthy: true,
      consecutiveFailures: 0,
      lastFailureTime: 0,
      lastSuccessTime: 0,
      lastHealthCheckTime: 0,
      totalRequests: 0,
      totalFailures: 0,
    });
  }

  getProvider(type: AIProviderType): AIProvider | undefined {
    return this.providers.get(type);
  }

  // ============================================
  // CONFIGURATION
  // ============================================

  updateConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  setPrimaryProvider(type: AIProviderType): void {
    if (!this.providers.has(type)) {
      throw new AIError(`Provider ${type} is not registered`, 'INVALID_REQUEST');
    }
    this.config.primaryProvider = type;
  }

  setFallbackProvider(type: AIProviderType | undefined): void {
    if (type && !this.providers.has(type)) {
      throw new AIError(`Provider ${type} is not registered`, 'INVALID_REQUEST');
    }
    this.config.fallbackProvider = type;
  }

  // ============================================
  // ROUTING LOGIC
  // ============================================

  /** Execute a request with auto-fallback */
  async route(request: ProviderRequest): Promise<ProviderResponse & { provider: AIProviderType }> {
    const primaryType = this.config.primaryProvider;
    const primary = this.providers.get(primaryType);

    if (!primary) {
      throw new AIError(
        `Primary provider ${primaryType} is not registered`,
        'API_ERROR'
      );
    }

    // Try primary provider
    if (this.isProviderUsable(primaryType)) {
      try {
        // Adapt the model id to the primary provider's namespace before
        // calling it. Upstream this only happened on the fallback path, which
        // was safe when Bedrock was the only Anthropic provider. It is not
        // safe now: callers hardcode Bedrock inference-profile ids, and
        // sending one of those to the direct API fails with a
        // ValidationException indistinguishable from a credentials problem.
        const adapted = this.adaptRequestForProvider(request, primaryType);
        const response = await primary.createMessage(adapted);
        this.recordSuccess(primaryType);
        return { ...response, provider: primaryType };
      } catch (error) {
        this.recordFailure(primaryType);

        // If auto-fallback is disabled, throw immediately
        if (!this.config.enableAutoFallback || !this.config.fallbackProvider) {
          throw error;
        }

        console.error(
          `[ProviderRouter] Primary provider ${primaryType} failed, attempting fallback:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    // Try fallback provider
    return this.attemptFallback(request);
  }

  /** Execute a streaming request with auto-fallback */
  async routeStreaming(
    request: ProviderRequest
  ): Promise<{ stream: AsyncIterable<ProviderStreamEvent>; provider: AIProviderType }> {
    const primaryType = this.config.primaryProvider;
    const primary = this.providers.get(primaryType);

    if (!primary) {
      throw new AIError(
        `Primary provider ${primaryType} is not registered`,
        'API_ERROR'
      );
    }

    if (this.isProviderUsable(primaryType)) {
      try {
        const adapted = this.adaptRequestForProvider(request, primaryType);
        const stream = await primary.createStreamingMessage(adapted);
        this.recordSuccess(primaryType);
        return { stream, provider: primaryType };
      } catch (error) {
        this.recordFailure(primaryType);

        if (!this.config.enableAutoFallback || !this.config.fallbackProvider) {
          throw error;
        }

        console.error(
          `[ProviderRouter] Primary streaming provider ${primaryType} failed, attempting fallback`
        );
      }
    }

    return this.attemptStreamingFallback(request);
  }

  /** Execute a tool-use request with auto-fallback */
  async routeWithTools(
    request: ProviderRequest
  ): Promise<ProviderResponse & { provider: AIProviderType }> {
    const primaryType = this.config.primaryProvider;
    const primary = this.providers.get(primaryType);

    if (!primary) {
      throw new AIError(
        `Primary provider ${primaryType} is not registered`,
        'API_ERROR'
      );
    }

    if (this.isProviderUsable(primaryType)) {
      try {
        const adapted = this.adaptRequestForProvider(request, primaryType);
        const response = await primary.createMessageWithTools(adapted);
        this.recordSuccess(primaryType);
        return { ...response, provider: primaryType };
      } catch (error) {
        this.recordFailure(primaryType);

        if (!this.config.enableAutoFallback || !this.config.fallbackProvider) {
          throw error;
        }

        console.error(
          `[ProviderRouter] Primary tool-use provider ${primaryType} failed, attempting fallback`
        );
      }
    }

    return this.attemptToolsFallback(request);
  }

  // ============================================
  // FALLBACK LOGIC
  // ============================================

  private async attemptFallback(
    request: ProviderRequest
  ): Promise<ProviderResponse & { provider: AIProviderType }> {
    const fallbackType = this.config.fallbackProvider;
    if (!fallbackType) {
      throw new AIError('No fallback provider configured', 'API_ERROR');
    }

    const fallback = this.providers.get(fallbackType);
    if (!fallback) {
      throw new AIError(`Fallback provider ${fallbackType} is not registered`, 'API_ERROR');
    }

    if (!this.isProviderUsable(fallbackType)) {
      throw new AIError(
        `Both primary and fallback providers are unavailable`,
        'API_ERROR',
        { retryable: true, retryAfter: 30 }
      );
    }

    // Map the model to the fallback provider's equivalent
    const fallbackRequest = this.adaptRequestForProvider(request, fallbackType);

    try {
      const response = await fallback.createMessage(fallbackRequest);
      this.recordSuccess(fallbackType);
      console.error(`[ProviderRouter] Fallback to ${fallbackType} succeeded`);
      return { ...response, provider: fallbackType };
    } catch (error) {
      this.recordFailure(fallbackType);
      throw new AIError(
        `Both primary and fallback providers failed`,
        'API_ERROR',
        { retryable: true, retryAfter: 60 }
      );
    }
  }

  private async attemptStreamingFallback(
    request: ProviderRequest
  ): Promise<{ stream: AsyncIterable<ProviderStreamEvent>; provider: AIProviderType }> {
    const fallbackType = this.config.fallbackProvider;
    if (!fallbackType) {
      throw new AIError('No fallback provider configured', 'API_ERROR');
    }

    const fallback = this.providers.get(fallbackType);
    if (!fallback || !this.isProviderUsable(fallbackType)) {
      throw new AIError('Both providers are unavailable', 'API_ERROR', {
        retryable: true,
        retryAfter: 30,
      });
    }

    const fallbackRequest = this.adaptRequestForProvider(request, fallbackType);

    try {
      const stream = await fallback.createStreamingMessage(fallbackRequest);
      this.recordSuccess(fallbackType);
      return { stream, provider: fallbackType };
    } catch (error) {
      this.recordFailure(fallbackType);
      throw new AIError('Both primary and fallback streaming providers failed', 'API_ERROR', {
        retryable: true,
        retryAfter: 60,
      });
    }
  }

  private async attemptToolsFallback(
    request: ProviderRequest
  ): Promise<ProviderResponse & { provider: AIProviderType }> {
    const fallbackType = this.config.fallbackProvider;
    if (!fallbackType) {
      throw new AIError('No fallback provider configured', 'API_ERROR');
    }

    const fallback = this.providers.get(fallbackType);
    if (!fallback || !this.isProviderUsable(fallbackType)) {
      throw new AIError('Both providers are unavailable', 'API_ERROR', {
        retryable: true,
        retryAfter: 30,
      });
    }

    const fallbackRequest = this.adaptRequestForProvider(request, fallbackType);

    try {
      const response = await fallback.createMessageWithTools(fallbackRequest);
      this.recordSuccess(fallbackType);
      return { ...response, provider: fallbackType };
    } catch (error) {
      this.recordFailure(fallbackType);
      throw new AIError('Both primary and fallback tool-use providers failed', 'API_ERROR', {
        retryable: true,
        retryAfter: 60,
      });
    }
  }

  // ============================================
  // REQUEST ADAPTATION
  // ============================================

  /** Adapt a request for a different provider (mainly model mapping) */
  private adaptRequestForProvider(
    request: ProviderRequest,
    targetProvider: AIProviderType
  ): ProviderRequest {
    // Map the model to the target provider
    const targetModel = getEquivalentModel(request.model, targetProvider);

    return {
      ...request,
      model: targetModel,
    };
  }

  // ============================================
  // HEALTH TRACKING
  // ============================================

  private isProviderUsable(type: AIProviderType): boolean {
    const state = this.healthStates.get(type);
    if (!state) return false;

    // If healthy, always usable
    if (state.isHealthy) return true;

    // Check if cooldown has passed
    const now = Date.now();
    if (now - state.lastFailureTime >= this.config.failedProviderCooldownMs) {
      // Reset and allow retry
      state.isHealthy = true;
      state.consecutiveFailures = 0;
      return true;
    }

    return false;
  }

  private recordSuccess(type: AIProviderType): void {
    const state = this.healthStates.get(type);
    if (!state) return;

    state.isHealthy = true;
    state.consecutiveFailures = 0;
    state.lastSuccessTime = Date.now();
    state.totalRequests++;
  }

  private recordFailure(type: AIProviderType): void {
    const state = this.healthStates.get(type);
    if (!state) return;

    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();
    state.totalRequests++;
    state.totalFailures++;

    // Mark unhealthy after exceeding retry threshold
    if (state.consecutiveFailures >= this.config.maxRetriesBeforeFallback) {
      state.isHealthy = false;
    }
  }

  /** Run health checks on all registered providers */
  async runHealthChecks(): Promise<Map<AIProviderType, boolean>> {
    const results = new Map<AIProviderType, boolean>();

    const checks = Array.from(this.providers.entries()).map(
      async ([type, provider]) => {
        try {
          const healthy = await provider.healthCheck();
          const state = this.healthStates.get(type);
          if (state) {
            state.isHealthy = healthy;
            state.lastHealthCheckTime = Date.now();
            if (healthy) state.consecutiveFailures = 0;
          }
          results.set(type, healthy);
        } catch {
          const state = this.healthStates.get(type);
          if (state) {
            state.isHealthy = false;
            state.lastHealthCheckTime = Date.now();
          }
          results.set(type, false);
        }
      }
    );

    await Promise.all(checks);
    return results;
  }

  // ============================================
  // STATUS & DIAGNOSTICS
  // ============================================

  getProviderStatus(): ProviderInfo[] {
    return Array.from(this.providers.entries()).map(([type, provider]) => {
      const state = this.healthStates.get(type);
      return {
        type,
        name: provider.displayName,
        isAvailable: state?.isHealthy ?? false,
        lastHealthCheck: state?.lastHealthCheckTime,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
      };
    });
  }

  getRegisteredProviders(): AIProviderType[] {
    return Array.from(this.providers.keys());
  }

  /** Get available models for a provider */
  getModelsForProvider(type: AIProviderType): string[] {
    if (type === 'anthropic-bedrock') return ANTHROPIC_BEDROCK_MODELS.allModels;
    if (type === 'openai') return OPENAI_MODELS.allModels;
    return [];
  }

  /** Get all available models across all registered providers */
  getAllAvailableModels(): Array<{ provider: AIProviderType; model: string }> {
    const models: Array<{ provider: AIProviderType; model: string }> = [];
    for (const type of this.providers.keys()) {
      for (const model of this.getModelsForProvider(type)) {
        models.push({ provider: type, model });
      }
    }
    return models;
  }
}
