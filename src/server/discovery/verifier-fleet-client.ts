/**
 * Verifier Fleet dispatcher — HTTP client for the Phase A2 EC2 fleet.
 *
 * Posts `{ email, timeoutMs?, preferStartTls? }` to the fleet ALB. The ALB
 * round-robins across nodes, and each node uses its own Elastic IP as the
 * source for outbound SMTP probes — spreading reputation risk across
 * multiple IPs without needing to pay for Bouncer.
 *
 * Gated on two env vars; if either is missing the caller falls back to
 * in-process verification (Phase A1 behaviour):
 *   VERIFIER_FLEET_URL   — ALB URL (e.g. http://verifier-xxx.elb...)
 *   VERIFIER_FLEET_KEY   — shared secret the node service validates
 */

import type { DetailedResult, DetailedStatus } from './email-verification';

export function isVerifierFleetConfigured(): boolean {
  return Boolean(process.env.VERIFIER_FLEET_URL && process.env.VERIFIER_FLEET_KEY);
}

export interface FleetResult extends DetailedResult {
  /** Identifies which fleet node served this request (EC2 instance id). */
  nodeId?: string;
}

export async function verifyViaFleet(email: string, timeoutMs = 12_000): Promise<FleetResult> {
  const started = Date.now();
  const baseUrl = (process.env.VERIFIER_FLEET_URL || '').replace(/\/+$/, '');
  const key = process.env.VERIFIER_FLEET_KEY || '';
  if (!baseUrl || !key) {
    return { status: 'unknown', reason: 'fleet_unconfigured', durationMs: Date.now() - started };
  }

  try {
    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-verifier-key': key,
      },
      body: JSON.stringify({ email, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 2_000),
    });
    if (!res.ok) {
      return { status: 'unknown', reason: `fleet_${res.status}`, durationMs: Date.now() - started };
    }
    const data = await res.json() as Partial<FleetResult> & { status?: DetailedStatus };
    const status = (data.status as DetailedStatus) || 'unknown';
    return {
      status,
      reason: typeof data.reason === 'string' ? data.reason : 'fleet_ok',
      mxUsed: typeof data.mxUsed === 'string' ? data.mxUsed : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : Date.now() - started,
      nodeId: typeof data.nodeId === 'string' ? data.nodeId : undefined,
    };
  } catch (err) {
    const reason = err instanceof Error ? `fleet_${err.name || 'error'}` : 'fleet_error';
    return { status: 'unknown', reason, durationMs: Date.now() - started };
  }
}
