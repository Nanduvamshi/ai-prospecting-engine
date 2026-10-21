'use client';

import { clearSession, ensureFreshToken } from './auth/token';

/**
 * The HTTP client for every call the UI makes.
 *
 * Without a client layer, every inline `fetch()` call re-implements auth
 * headers, error handling and JSON parsing — slightly differently each time.
 * Routing everything through one place means a 401 is
 * handled once, and a credit exhaustion (402) is distinguishable from a
 * permission problem (403) without every caller checking.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Out of credits — the UI should offer a top-up, not an error toast. */
  get isCreditExhausted(): boolean {
    return this.status === 402;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the auth header. Used only by the public lead-finder tool. */
  anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, anonymous, headers, ...rest } = options;

  const finalHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...((headers as Record<string, string>) ?? {}),
  };

  if (!anonymous) {
    const token = await ensureFreshToken();
    if (token) finalHeaders.authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...rest,
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // 204 and other empty responses would otherwise throw on .json().
  const text = await response.text();
  const parsed: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    // A 401 means the session is gone. Clearing it locally stops every
    // subsequent request from retrying with a token the server rejected.
    if (response.status === 401) clearSession();

    const message =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : null) ?? `Request failed (${response.status})`;

    throw new ApiError(response.status, message, parsed);
  }

  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE', body }),
};

/** Build a query string, dropping empty values so `?status=` never appears. */
export function qs(params: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
