import 'server-only';

import { required } from '@/server/env';
import type {
  BillingContext,
  BillingProvider,
  ConsumeMeta,
  ConsumeResult,
  PreCheckResult,
} from './types';

/**
 * Metering against a remote HTTP service.
 *
 * Behaviourally this mirrors the credit gate it replaces — same timeout, same
 * single retry on network error only, same fail-closed posture, same short
 * balance cache — with one difference: `BILLING_API_URL` is required. The
 * original defaulted to a hardcoded production API Gateway URL, so a
 * misconfigured deployment silently billed against someone else's account.
 */

const TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 500;
const BALANCE_CACHE_MS = 30_000;

const balanceCache = new Map<string, { balance: number; at: number }>();

function cacheKey(ctx: BillingContext): string {
  // Keyed on the org, not the token: two users in one org share a balance,
  // and tokens rotate far more often than balances change.
  return ctx.orgId;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class HttpBillingProvider implements BillingProvider {
  readonly id = 'http';
  readonly requiresAuthToken = true;

  private baseUrl(): string {
    return required('BILLING_API_URL').replace(/\/+$/, '');
  }

  private headers(ctx: BillingContext): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {}),
      'x-org-id': ctx.orgId,
      'x-user-id': ctx.userId,
    };
  }

  async preCheck(ctx: BillingContext, minCredits: number): Promise<PreCheckResult> {
    const cached = balanceCache.get(cacheKey(ctx));
    if (cached && Date.now() - cached.at < BALANCE_CACHE_MS) {
      return cached.balance >= minCredits
        ? { ok: true, balance: cached.balance }
        : {
            ok: false,
            balance: cached.balance,
            reason: 'INSUFFICIENT_CREDITS',
            message: 'Not enough credits remaining for this search.',
          };
    }

    try {
      const response = await fetchWithTimeout(`${this.baseUrl()}/credits`, {
        method: 'GET',
        headers: this.headers(ctx),
      });

      if (response.status === 402) {
        return {
          ok: false,
          balance: 0,
          reason: 'INSUFFICIENT_CREDITS',
          message: 'Not enough credits remaining for this search.',
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          balance: 0,
          reason: 'SUBSCRIPTION_INACTIVE',
          message: 'Your subscription is not active.',
        };
      }
      if (!response.ok) {
        // Fail closed. A metering service that cannot answer is not
        // permission to spend money.
        return {
          ok: false,
          balance: 0,
          reason: 'UNAVAILABLE',
          message: 'Billing is temporarily unavailable. Please try again shortly.',
        };
      }

      const body = (await response.json()) as { balance?: number };
      const balance = typeof body.balance === 'number' ? body.balance : 0;
      balanceCache.set(cacheKey(ctx), { balance, at: Date.now() });

      return balance >= minCredits
        ? { ok: true, balance }
        : {
            ok: false,
            balance,
            reason: 'INSUFFICIENT_CREDITS',
            message: 'Not enough credits remaining for this search.',
          };
    } catch (err) {
      console.error('[billing:http] preCheck failed:', err instanceof Error ? err.message : err);
      return {
        ok: false,
        balance: 0,
        reason: 'UNAVAILABLE',
        message: 'Billing is temporarily unavailable. Please try again shortly.',
      };
    }
  }

  async consume(
    ctx: BillingContext,
    feature: string,
    amount: number,
    meta?: ConsumeMeta,
  ): Promise<ConsumeResult> {
    const payload = JSON.stringify({
      feature,
      amount,
      description: meta?.description,
      context: meta?.context,
      parentTransactionId: meta?.parentTransactionId,
    });

    const attempt = async (): Promise<Response> =>
      fetchWithTimeout(`${this.baseUrl()}/credits/consume`, {
        method: 'POST',
        headers: this.headers(ctx),
        body: payload,
      });

    let response: Response;
    try {
      response = await attempt();
    } catch {
      // Retry once, and only for transport failures. A 4xx is an answer and
      // repeating it would risk double-charging.
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        response = await attempt();
      } catch (err) {
        // The work is already done at this point — refusing to record the
        // charge is the safer failure, so log loudly and move on.
        console.error(
          '[billing:http] consume failed after retry; usage went unrecorded:',
          err instanceof Error ? err.message : err,
        );
        return { success: false, remainingBalance: 0 };
      }
    }

    balanceCache.delete(cacheKey(ctx));

    if (!response.ok) {
      console.error('[billing:http] consume rejected with status', response.status);
      return { success: false, remainingBalance: 0 };
    }

    const body = (await response.json().catch(() => ({}))) as {
      remainingBalance?: number;
      transactionId?: string;
    };
    return {
      success: true,
      remainingBalance: typeof body.remainingBalance === 'number' ? body.remainingBalance : 0,
      transactionId: body.transactionId,
    };
  }
}
