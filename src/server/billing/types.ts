import 'server-only';

/**
 * Billing seam.
 *
 * The engine spends real money — search API calls, LLM tokens, SMTP probes,
 * scraping credits — so metering has to be *possible*. But the product must
 * also run for someone who has not set up billing at all.
 *
 * So the pipeline talks to this interface and never to a billing vendor. The
 * default implementation always allows. Swapping in Stripe metering or an
 * internal ledger is a config change, not a pipeline change.
 *
 * The deferred shape matters: precheck
 * before starting, run the work, consume only once the work has succeeded.
 * A run that crashes therefore costs the user nothing.
 */

export interface BillingContext {
  orgId: string;
  userId: string;
  /** Only used by providers that authenticate to a remote metering service. */
  authToken?: string;
}

export type PreCheckResult =
  | { ok: true; balance: number }
  | {
      ok: false;
      balance: number;
      reason: 'INSUFFICIENT_CREDITS' | 'SUBSCRIPTION_INACTIVE' | 'UNAVAILABLE';
      message: string;
    };

export interface ConsumeMeta {
  /** Human-readable line for the credit log. */
  description?: string;
  /** Structured context — surface, query, result counts, etc. */
  context?: Record<string, unknown>;
  /** Groups this charge under a parent transaction when one tool call
   *  triggered another. */
  parentTransactionId?: string;
}

export interface ConsumeResult {
  success: boolean;
  remainingBalance: number;
  transactionId?: string;
}

export interface BillingProvider {
  readonly id: string;
  /**
   * Whether this provider needs the caller's bearer token to settle later.
   *
   * When false — the default — the job row never persists an auth token.
   * Storing a user's bearer token at rest for the benefit of a no-op is pure
   * liability.
   */
  readonly requiresAuthToken: boolean;

  preCheck(ctx: BillingContext, minCredits: number): Promise<PreCheckResult>;
  consume(
    ctx: BillingContext,
    feature: string,
    amount: number,
    meta?: ConsumeMeta,
  ): Promise<ConsumeResult>;
}
