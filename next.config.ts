import type { NextConfig } from 'next';

/**
 * Deliberately minimal.
 *
 * Two things this file deliberately does NOT do:
 *
 *  1. There is no `env: {}` block. Hardcoded production pool ids and API URLs
 *     as fallbacks would mean a fresh clone silently talks to production.
 *     Every value comes from the real environment or the process fails loudly
 *     at startup.
 *
 *  2. `typescript.ignoreBuildErrors` is NOT set. It masks genuine bugs — it
 *     once hid an undefined variable in the find-leads pipeline's metadata
 *     object. Type errors fail the build here.
 */
const nextConfig: NextConfig = {
  // `standalone` produces .next/standalone/server.js for the Docker runner.
  // Disabled on Windows because the output tracing does not work there.
  output: process.platform === 'win32' ? undefined : 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,

  // cheerio + node dns/net/tls are used by the discovery layer. Keeping them
  // external stops Next from trying to bundle native/node-only code.
  serverExternalPackages: ['cheerio', 'pg'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
