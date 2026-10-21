import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, type AuthUser } from '@/server/auth/require-auth';

/**
 * Route helpers.
 *
 * Every authenticated route repeats the same four lines of auth plumbing.
 * These collapse that without hiding anything: `withAuth` still hands the
 * handler a plain user object and expects a plain Response back.
 */

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, ...data }, init);
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: message, ...extra }, { status });
}

/**
 * Wrap a handler so it only runs for an authenticated caller.
 *
 * Unexpected throws become a 500 with a generic message — the detail goes to
 * the logs. Leaking a database error to the client tells an attacker about
 * the schema and tells the user nothing useful.
 */
export function withAuth<Ctx = unknown>(
  handler: (request: NextRequest, user: AuthUser, ctx: Ctx) => Promise<Response>,
) {
  return async (request: NextRequest, ctx: Ctx): Promise<Response> => {
    try {
      const { user, error } = await requireAuth(request);
      if (error || !user) {
        return fail(error?.message ?? 'Authentication required', error?.status ?? 401);
      }
      return await handler(request, user, ctx);
    } catch (err) {
      console.error(`[${request.method} ${new URL(request.url).pathname}]`, err);
      return fail('Something went wrong on our side. Please try again.', 500);
    }
  };
}

/** Parse a JSON body, returning null rather than throwing on malformed input. */
export async function readJson<T>(request: NextRequest): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** A repeated query parameter, or a comma-separated list, as an array. */
export function readList(request: NextRequest, key: string): string[] {
  const url = new URL(request.url);
  const all = url.searchParams.getAll(key);
  if (all.length > 1) return all;
  const single = all[0];
  if (!single) return [];
  return single.split(',').map((s) => s.trim()).filter(Boolean);
}

export function readParam(request: NextRequest, key: string): string | null {
  return new URL(request.url).searchParams.get(key);
}

export function readInt(request: NextRequest, key: string, fallback: number): number {
  const raw = readParam(request, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Display name for the acting user, for owner attribution. */
export function actorOf(user: AuthUser): { userId: string; name: string } {
  return { userId: user.sub, name: user.name || user.email || user.sub };
}
