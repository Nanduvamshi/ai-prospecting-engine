import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { required, optional, IS_PRODUCTION } from '@/server/env';

/**
 * Request authentication.
 *
 * This is the minimal JWT path only, on purpose. There are no alternative ways
 * in — no opaque session tokens resolved against a users table, no
 * self-asserted "internal service" tokens, no shared-secret bypass headers.
 * Each of those is an extra attack surface for no benefit here.
 *
 * The org claim is authoritative: if `custom:org_id` is absent the request is
 * rejected. That puts the burden on signup to set it (see the
 * post-confirmation Lambda in infra/), which is the right place for it.
 *
 * Every route destructures the `{ user, error }` return shape, so auth
 * failures are handled the same way everywhere.
 */

export interface AuthUser {
  sub: string;
  email: string;
  orgId: string;
  role?: string;
  name?: string;
}

export interface AuthError {
  status: number;
  message: string;
}

export type AuthResult =
  | { user: AuthUser; error?: undefined }
  | { user: null; error: AuthError };

type AuthMode = 'dev' | 'cognito';

const AUTH_MODE: AuthMode = (process.env.AUTH_MODE as AuthMode) ?? 'cognito';

// Fail at module load rather than at first request: serving traffic with dev
// auth enabled is a security incident, and the only reliable moment to catch
// it is before anything can be served.
//
// The build phase is exempt. `next build` runs with NODE_ENV=production while
// collecting route metadata, so without this exemption you could not produce a
// production bundle on a machine whose .env is set up for development — the
// guard would reject a perfectly legitimate build. The check still fires when
// the built server actually starts.
const IS_BUILD_PHASE = process.env.NEXT_PHASE === 'phase-production-build';

if (AUTH_MODE === 'dev' && IS_PRODUCTION && !IS_BUILD_PHASE) {
  throw new Error(
    'AUTH_MODE=dev is forbidden when NODE_ENV=production. ' +
      'Set AUTH_MODE=cognito and provide COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID.',
  );
}

/**
 * Built on first use, never at module scope.
 *
 * Upstream this was constructed as a module-level constant, which meant that
 * merely importing the auth module required a user pool id — so dev mode
 * could not avoid needing Cognito configuration it never used.
 */
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: required('COGNITO_USER_POOL_ID'),
      tokenUse: 'id',
      clientId: required('COGNITO_CLIENT_ID'),
    });
  }
  return verifier;
}

function devUser(): AuthUser {
  return {
    sub: optional('DEV_USER_ID') ?? 'dev-user',
    email: optional('DEV_USER_EMAIL') ?? 'dev@localhost',
    orgId: optional('DEV_ORG_ID') ?? 'dev-org',
    role: 'admin',
    name: 'Development User',
  };
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  // The middleware sets this cookie on login so it can do a presence check
  // without parsing the JWT; accepting it here lets same-origin fetches that
  // omit the header still authenticate.
  return request.cookies.get('prospecting-auth')?.value ?? null;
}

export async function requireAuth(request: NextRequest): Promise<AuthResult> {
  if (AUTH_MODE === 'dev') {
    return { user: devUser() };
  }

  const token = bearerToken(request);
  if (!token) {
    return { user: null, error: { status: 401, message: 'Authentication required' } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await getVerifier().verify(token)) as unknown as Record<string, unknown>;
  } catch {
    // Deliberately opaque: distinguishing "expired" from "malformed" from
    // "wrong pool" tells an attacker more than it helps a user.
    return { user: null, error: { status: 401, message: 'Invalid or expired session' } };
  }

  const orgId = typeof payload['custom:org_id'] === 'string' ? payload['custom:org_id'] : '';
  if (!orgId || orgId === 'default') {
    return {
      user: null,
      error: {
        status: 403,
        message: 'No organization is associated with this account.',
      },
    };
  }

  return {
    user: {
      sub: String(payload.sub ?? ''),
      email: String(payload.email ?? ''),
      orgId,
      role: typeof payload['custom:role'] === 'string' ? payload['custom:role'] : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    },
  };
}

/** Same as requireAuth, but additionally requires an admin role. */
export async function requireAdmin(request: NextRequest): Promise<AuthResult> {
  const result = await requireAuth(request);
  if (!result.user) return result;
  if (result.user.role !== 'admin' && result.user.role !== 'super_admin') {
    return { user: null, error: { status: 403, message: 'Administrator access required' } };
  }
  return result;
}

export function isDevAuth(): boolean {
  return AUTH_MODE === 'dev';
}

/**
 * Turn an auth failure into an HTTP response.
 *
 * Several routes were written as `if (authError) return authError;` — which
 * returns a plain `{ status, message }` object from a route handler, not a
 * Response. It type-checks only when build-time type errors are disabled, and
 * it would produce a broken reply for every
 * unauthenticated request. Dev-mode auth never fails, so it stays invisible
 * locally.
 */
export function authErrorResponse(error: AuthError | undefined): NextResponse {
  return NextResponse.json(
    { success: false, error: error?.message ?? 'Authentication required' },
    { status: error?.status ?? 401 },
  );
}
