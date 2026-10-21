import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Edge auth gate.
 *
 * Presence check only — it never verifies the JWT. That is deliberate:
 * signature verification belongs in the route
 * handlers, where `requireAuth` does it properly with the Cognito JWKS. This
 * exists so an unauthenticated browser lands on /login instead of on a page
 * that renders a shell and then fails every fetch.
 *
 * The public allowlist is kept deliberately short: this product has no
 * marketing site, docs, blog, careers page or embeddable widget.
 */

const PUBLIC_ROUTES = ['/login', '/signup', '/forgot-password', '/tools/lead-finder'];

export function middleware(request: NextRequest) {
  // In dev auth mode there is no session to have, and redirecting to a login
  // page that cannot do anything useful just makes local runs confusing.
  if (process.env.AUTH_MODE === 'dev') {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  if (PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return NextResponse.next();
  }

  // API routes authenticate themselves (and cron routes use a shared secret
  // rather than a session, so a redirect would be actively wrong).
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/static/') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  if (!request.cookies.get('prospecting-auth')?.value) {
    const loginUrl = new URL('/login', request.url);
    // Only ever echo back a same-origin path, so a crafted link cannot use
    // the redirect parameter to bounce someone off-site after login.
    const safeRedirect =
      pathname.startsWith('/') && !pathname.startsWith('//') && !pathname.includes('://')
        ? pathname
        : '/';
    loginUrl.searchParams.set('redirect', safeRedirect);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
