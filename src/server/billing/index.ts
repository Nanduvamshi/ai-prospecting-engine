import 'server-only';

import { NextResponse } from 'next/server';
import { NoopBillingProvider } from './noop';
import { HttpBillingProvider } from './http';
import type { BillingContext, BillingProvider, PreCheckResult } from './types';

export type {
  BillingContext,
  BillingProvider,
  ConsumeMeta,
  ConsumeResult,
  PreCheckResult,
} from './types';
export { NoopBillingProvider } from './noop';
export { HttpBillingProvider } from './http';
export * from './lead-credit-cost';

let instance: BillingProvider | null = null;

/** The configured provider. Defaults to the no-op. */
export function getBillingProvider(): BillingProvider {
  if (!instance) {
    const kind = process.env.BILLING_PROVIDER ?? 'noop';
    instance = kind === 'http' ? new HttpBillingProvider() : new NoopBillingProvider();
    if (kind !== 'noop') console.log('[billing] provider:', instance.id);
  }
  return instance;
}

/** Reset for tests. */
export function resetBillingProvider(): void {
  instance = null;
}

/**
 * Turn a failed precheck into the right HTTP response.
 *
 * 402 for "out of credits" and 403 for "subscription lapsed" are what the
 * existing client code branches on, so the codes are preserved.
 */
export function billingErrorResponse(result: Extract<PreCheckResult, { ok: false }>) {
  const status =
    result.reason === 'INSUFFICIENT_CREDITS' ? 402 : result.reason === 'SUBSCRIPTION_INACTIVE' ? 403 : 503;

  return NextResponse.json(
    { success: false, error: result.message, reason: result.reason, balance: result.balance },
    { status, headers: { 'x-credits-remaining': String(result.balance) } },
  );
}

/**
 * Wrap a handler that spends a fixed, known amount.
 *
 * Deliberately still deferred: the charge lands after the handler returns
 * successfully, so a thrown handler costs nothing. The find-leads pipeline
 * does not use this — its cost is only known once the leads are in hand, so
 * it calls `consume` directly at the end of the run.
 */
export async function withBilling<T>(
  ctx: BillingContext,
  feature: string,
  cost: number,
  handler: () => Promise<T>,
): Promise<{ ok: true; value: T; remaining: number } | { ok: false; response: NextResponse }> {
  const billing = getBillingProvider();
  const gate = await billing.preCheck(ctx, cost);
  if (!gate.ok) {
    return { ok: false, response: billingErrorResponse(gate) };
  }

  const value = await handler();
  const consumed = await billing.consume(ctx, feature, cost, {
    description: `${feature} — ${cost} credit${cost === 1 ? '' : 's'}`,
  });

  return { ok: true, value, remaining: consumed.remainingBalance };
}
