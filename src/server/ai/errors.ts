// ============================================
// AI ERROR HANDLING
// Centralized error handling for AI operations
// ============================================

// Error types
export type AIErrorCode =
  | 'RATE_LIMIT'
  | 'INVALID_REQUEST'
  | 'API_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'AUTH_ERROR'
  | 'CONTEXT_TOO_LARGE'
  | 'CONTENT_FILTERED'
  | 'MODEL_OVERLOADED'
  | 'INVALID_RESPONSE'
  | 'ACTION_FAILED'
  | 'AGENT_ERROR'
  | 'UNKNOWN';

// Custom AI Error class
export class AIError extends Error {
  code: AIErrorCode;
  statusCode?: number;
  retryable: boolean;
  retryAfter?: number; // Seconds
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: AIErrorCode = 'UNKNOWN',
    options?: {
      statusCode?: number;
      retryable?: boolean;
      retryAfter?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? isRetryableError(code);
    this.retryAfter = options?.retryAfter;
    this.details = options?.details;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      details: this.details,
    };
  }
}

// Check if an error code is retryable
function isRetryableError(code: AIErrorCode): boolean {
  return ['RATE_LIMIT', 'TIMEOUT', 'NETWORK_ERROR', 'MODEL_OVERLOADED'].includes(
    code
  );
}

// Parse error from Anthropic API response
export function parseAnthropicError(error: unknown): AIError {
  return parseProviderError(error);
}

// Parse error from any AI provider (Anthropic or OpenAI)
export function parseProviderError(error: unknown): AIError {
  // Handle Anthropic API errors
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Rate limit error (429 — both Anthropic and OpenAI)
    if (err.status === 429) {
      const retryAfter = typeof err.headers === 'object' && err.headers
        ? (err.headers as Record<string, string>)['retry-after']
        : undefined;

      return new AIError('Rate limit exceeded. Please try again later.', 'RATE_LIMIT', {
        statusCode: 429,
        retryable: true,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : 60,
      });
    }

    // Authentication error (401 — both providers)
    if (err.status === 401) {
      return new AIError('Invalid API key or authentication failed.', 'AUTH_ERROR', {
        statusCode: 401,
        retryable: false,
      });
    }

    // OpenAI insufficient quota (402)
    if (err.status === 402) {
      return new AIError('API quota exceeded. Please check your billing.', 'AUTH_ERROR', {
        statusCode: 402,
        retryable: false,
      });
    }

    // Bad request (400 — both providers)
    if (err.status === 400) {
      const message = typeof err.message === 'string' ? err.message : 'Invalid request';
      return new AIError(message, 'INVALID_REQUEST', {
        statusCode: 400,
        retryable: false,
      });
    }

    // OpenAI forbidden / content policy (403)
    if (err.status === 403) {
      return new AIError('Request blocked by content policy.', 'CONTENT_FILTERED', {
        statusCode: 403,
        retryable: false,
      });
    }

    // Anthropic overloaded (529)
    if (err.status === 529) {
      return new AIError('The AI service is currently overloaded. Please try again.', 'MODEL_OVERLOADED', {
        statusCode: 529,
        retryable: true,
        retryAfter: 30,
      });
    }

    // Server error (500+ — both providers)
    if (typeof err.status === 'number' && err.status >= 500) {
      return new AIError('AI service error. Please try again.', 'API_ERROR', {
        statusCode: err.status,
        retryable: true,
      });
    }

    // OpenAI-style error object: { error: { message, type, code } }
    if (err.error && typeof err.error === 'object') {
      const inner = err.error as Record<string, unknown>;
      const msg = typeof inner.message === 'string' ? inner.message : 'API error';
      const code = inner.code as string | undefined;

      if (code === 'context_length_exceeded') {
        return new AIError(msg, 'CONTEXT_TOO_LARGE', { retryable: false });
      }
      if (code === 'content_filter') {
        return new AIError(msg, 'CONTENT_FILTERED', { retryable: false });
      }

      return new AIError(msg, 'API_ERROR', {
        statusCode: typeof err.status === 'number' ? err.status : undefined,
      });
    }

    // Extract message from error object
    if (typeof err.message === 'string') {
      return new AIError(err.message, 'API_ERROR', {
        statusCode: typeof err.status === 'number' ? err.status : undefined,
      });
    }
  }

  // Handle Error instances
  if (error instanceof Error) {
    // Timeout errors
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      return new AIError('Request timed out. Please try again.', 'TIMEOUT', {
        retryable: true,
      });
    }

    // Network errors
    if (
      error.message.includes('fetch') ||
      error.message.includes('network') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND')
    ) {
      return new AIError('Network error. Please check your connection.', 'NETWORK_ERROR', {
        retryable: true,
      });
    }

    // OpenAI SDK specific errors
    if (error.name === 'APIError' || error.name === 'APIConnectionError') {
      return new AIError(error.message, 'API_ERROR', { retryable: true });
    }
    if (error.name === 'RateLimitError') {
      return new AIError(error.message, 'RATE_LIMIT', { retryable: true, retryAfter: 60 });
    }
    if (error.name === 'AuthenticationError') {
      return new AIError(error.message, 'AUTH_ERROR', { retryable: false });
    }

    return new AIError(error.message, 'UNKNOWN');
  }

  // Unknown error
  return new AIError('An unexpected error occurred.', 'UNKNOWN');
}

// User-friendly error messages
export function getUserFriendlyMessage(error: AIError): string {
  const messages: Record<AIErrorCode, string> = {
    RATE_LIMIT: 'Too many requests. Please wait a moment and try again.',
    INVALID_REQUEST: 'There was a problem with your request. Please try again.',
    API_ERROR: 'The AI service encountered an error. Please try again.',
    TIMEOUT: 'The request took too long. Please try again.',
    NETWORK_ERROR: 'Connection issue. Please check your internet and try again.',
    AUTH_ERROR: 'Authentication failed. Please contact support.',
    CONTEXT_TOO_LARGE: 'The conversation is too long. Try starting a new conversation.',
    CONTENT_FILTERED: 'The content was filtered. Please rephrase your request.',
    MODEL_OVERLOADED: 'The AI is busy. Please try again in a moment.',
    INVALID_RESPONSE: 'Received an unexpected response. Please try again.',
    ACTION_FAILED: 'The action could not be completed. Please try again.',
    AGENT_ERROR: 'The AI agent encountered an error.',
    UNKNOWN: 'Something went wrong. Please try again.',
  };

  return messages[error.code] || messages.UNKNOWN;
}

// Retry utility with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    onRetry?: (error: AIError, attempt: number) => void;
  }
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    onRetry,
  } = options || {};

  let lastError: AIError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const aiError = error instanceof AIError ? error : parseAnthropicError(error);
      lastError = aiError;

      // Don't retry non-retryable errors
      if (!aiError.retryable || attempt === maxRetries) {
        throw aiError;
      }

      // Calculate delay with exponential backoff
      let delay = aiError.retryAfter
        ? aiError.retryAfter * 1000
        : Math.min(initialDelay * Math.pow(2, attempt), maxDelay);

      // Add jitter (10% randomness)
      delay = delay * (0.9 + Math.random() * 0.2);

      // Notify about retry
      if (onRetry) {
        onRetry(aiError, attempt + 1);
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new AIError('Max retries exceeded', 'UNKNOWN');
}

// Error boundary helper for React components
export function handleAIError(
  error: unknown,
  options?: {
    showToast?: (message: string) => void;
    logError?: (error: AIError) => void;
  }
): AIError {
  const aiError = error instanceof AIError ? error : parseAnthropicError(error);

  // Log the error
  if (options?.logError) {
    options.logError(aiError);
  } else {
    console.error('[AI Error]', aiError.toJSON());
  }

  // Show user-friendly message
  if (options?.showToast) {
    options.showToast(getUserFriendlyMessage(aiError));
  }

  return aiError;
}

// Create error response for API routes
export function createErrorResponse(error: unknown): {
  success: false;
  error: string;
  code: AIErrorCode;
  retryable: boolean;
} {
  const aiError = error instanceof AIError ? error : parseAnthropicError(error);

  return {
    success: false,
    error: getUserFriendlyMessage(aiError),
    code: aiError.code,
    retryable: aiError.retryable,
  };
}
