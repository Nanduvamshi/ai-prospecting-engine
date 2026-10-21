import 'server-only';

import type {
  BillingContext,
  BillingProvider,
  ConsumeMeta,
  ConsumeResult,
  PreCheckResult,
} from './types';

/**
 * A finite, large balance — not Infinity.
 *
 * The pipeline compares `totalCost > creditBalance` and then stamps the
 * resulting figure into job metadata that the UI renders. `Infinity`
 * serializes to `null` through JSON, so the UI would show a blank where a
 * number belongs. A million credits is effectively unlimited and survives the
 * round trip.
 */
const UNLIMITED = 1_000_000;

/** Always allows, never charges. The default. */
export class NoopBillingProvider implements BillingProvider {
  readonly id = 'noop';
  readonly requiresAuthToken = false;

  async preCheck(_ctx: BillingContext, _minCredits: number): Promise<PreCheckResult> {
    return { ok: true, balance: UNLIMITED };
  }

  async consume(
    _ctx: BillingContext,
    feature: string,
    amount: number,
    meta?: ConsumeMeta,
  ): Promise<ConsumeResult> {
    // Logged rather than silent: cost visibility is useful even when nobody
    // is being charged, and it is how you notice a runaway job.
    if (amount > 0) {
      console.log(
        `[billing:noop] would charge ${amount} credit${amount === 1 ? '' : 's'} for ${feature}` +
          (meta?.description ? ` — ${meta.description}` : ''),
      );
    }
    return { success: true, remainingBalance: UNLIMITED };
  }
}
