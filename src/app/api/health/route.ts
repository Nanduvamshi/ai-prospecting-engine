import { NextResponse } from 'next/server';
import { pingDatabase } from '@/server/db/client';
import { capabilities, logCapabilitiesOnce } from '@/server/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  logCapabilitiesOnce();
  const database = await pingDatabase();

  return NextResponse.json(
    {
      ok: database.ok,
      service: 'prospecting',
      database: database.ok
        ? { ok: true, version: database.version?.split(' ').slice(0, 2).join(' ') }
        : { ok: false, error: database.error },
      authMode: process.env.AUTH_MODE ?? 'cognito',
      billingProvider: process.env.BILLING_PROVIDER ?? 'noop',
      capabilities: capabilities(),
    },
    { status: database.ok ? 200 : 503 },
  );
}
