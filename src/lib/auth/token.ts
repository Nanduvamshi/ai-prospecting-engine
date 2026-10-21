'use client';

/**
 * Client-side session token.
 *
 * One helper, so there is exactly one answer to "am I logged in".
 *
 * Reads are synchronous from localStorage, which is what callers want. Refresh
 * talks to the Cognito
 * IDP endpoint over plain fetch, which is a single JSON POST, so the heavy
 * client SDK is not a dependency here at all.
 */

const ID_TOKEN_KEY = 'prospecting.idToken';
const REFRESH_TOKEN_KEY = 'prospecting.refreshToken';
const AUTH_COOKIE = 'prospecting-auth';

/** Refresh this far ahead of expiry, so a request in flight cannot age out. */
const REFRESH_SKEW_SECONDS = 120;

export interface Session {
  idToken: string;
  refreshToken?: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function getIdToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(ID_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setSession(session: Session): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(ID_TOKEN_KEY, session.idToken);
  if (session.refreshToken) {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
  }
  // Mirrored into a cookie purely so the edge middleware can do a presence
  // check without parsing anything. The server still verifies the JWT itself.
  document.cookie = `${AUTH_COOKIE}=${session.idToken}; path=/; SameSite=Lax; max-age=86400`;
}

export function clearSession(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(ID_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  document.cookie = `${AUTH_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
}

interface JwtClaims {
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
  'custom:org_id'?: string;
  'custom:role'?: string;
}

/**
 * Read a JWT payload without verifying it.
 *
 * Display only — the signature is checked server-side on every request. This
 * exists so the UI can show a name and role without a round trip, never to
 * make an access decision.
 */
export function decodeClaims(token: string | null): JwtClaims | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as JwtClaims;
  } catch {
    return null;
  }
}

export function isExpired(token: string | null, skewSeconds = REFRESH_SKEW_SECONDS): boolean {
  const claims = decodeClaims(token);
  if (!claims?.exp) return true;
  return claims.exp - skewSeconds <= Math.floor(Date.now() / 1000);
}

/** Deduplicates concurrent refreshes — a page issuing six parallel fetches
 *  should trigger one token exchange, not six. */
let inFlightRefresh: Promise<string | null> | null = null;

async function refreshIdToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  const region = process.env.NEXT_PUBLIC_COGNITO_REGION ?? 'ap-south-1';
  if (!refreshToken || !clientId) return null;

  try {
    const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { AuthenticationResult?: { IdToken?: string } };
    const idToken = body.AuthenticationResult?.IdToken;
    if (!idToken) return null;

    setSession({ idToken, refreshToken });
    return idToken;
  } catch {
    return null;
  }
}

/**
 * A usable token, refreshed if it is close to expiring.
 *
 * In dev auth mode the server ignores the value entirely, so a placeholder
 * keeps the calling code identical across both modes.
 */
export async function ensureFreshToken(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_AUTH_MODE === 'dev') return 'dev';

  const token = getIdToken();
  if (token && !isExpired(token)) return token;

  if (!inFlightRefresh) {
    inFlightRefresh = refreshIdToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}
