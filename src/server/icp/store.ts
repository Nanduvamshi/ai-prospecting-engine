import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { orgIcp } from '@/server/db/schema';
import type { CustomerICP } from './fit-scoring';

/**
 * Ideal Customer Profile storage.
 *
 * One ICP per organisation — the least surprising place for it, since a sales
 * team shares one definition of who they are selling to. The key is composite
 * so per-product ICPs can be added later without a migration.
 */

const DEFAULT_KEY = 'default';

export async function getOrgICP(orgId: string, icpKey = DEFAULT_KEY): Promise<CustomerICP | null> {
  if (!orgId) return null;
  try {
    const rows = await db
      .select({ icp: orgIcp.icp })
      .from(orgIcp)
      .where(and(eq(orgIcp.orgId, orgId), eq(orgIcp.icpKey, icpKey)))
      .limit(1);
    return rows[0]?.icp ?? null;
  } catch (err) {
    // A missing ICP is a normal state — scoring falls back to generic
    // heuristics — so a read failure degrades rather than throws.
    console.error('[icp] read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function setOrgICP(opts: {
  orgId: string;
  icp: CustomerICP;
  updatedBy: string;
  icpKey?: string;
}): Promise<void> {
  const icpKey = opts.icpKey ?? DEFAULT_KEY;
  await db
    .insert(orgIcp)
    .values({
      orgId: opts.orgId,
      icpKey,
      icp: opts.icp,
      updatedBy: opts.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orgIcp.orgId, orgIcp.icpKey],
      set: { icp: opts.icp, updatedBy: opts.updatedBy, updatedAt: new Date() },
    });
}

export async function deleteOrgICP(orgId: string, icpKey = DEFAULT_KEY): Promise<void> {
  await db.delete(orgIcp).where(and(eq(orgIcp.orgId, orgId), eq(orgIcp.icpKey, icpKey)));
}

/** Validate incoming ICP payload — rejects obviously-malformed input. */
export function validateICP(raw: unknown): { ok: true; icp: CustomerICP } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'ICP must be an object' };
  const obj = raw as Record<string, unknown>;
  const icp: CustomerICP = {};

  const asStringArray = (v: unknown, max = 20): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max);
    return arr.length > 0 ? arr.map(s => s.trim()) : undefined;
  };

  icp.industries = asStringArray(obj.industries);
  icp.titles = asStringArray(obj.titles);
  icp.geographies = asStringArray(obj.geographies);
  icp.useCases = asStringArray(obj.useCases, 10);
  if (Array.isArray(obj.companySizes)) {
    const valid = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
    icp.companySizes = obj.companySizes.filter(
      (s): s is typeof valid[number] => typeof s === 'string' && (valid as readonly string[]).includes(s),
    );
    if (icp.companySizes.length === 0) delete icp.companySizes;
  }
  if (typeof obj.customCriteria === 'string' && obj.customCriteria.trim().length > 0) {
    icp.customCriteria = obj.customCriteria.trim().slice(0, 2000);
  }

  // Outreach context — optional nested object
  if (obj.outreach && typeof obj.outreach === 'object') {
    const o = obj.outreach as Record<string, unknown>;
    const out: CustomerICP['outreach'] = {};
    const asTrimmedString = (v: unknown, max = 200) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : undefined;
    out.companyName = asTrimmedString(o.companyName, 80);
    out.valueProp = asTrimmedString(o.valueProp, 300);
    out.senderName = asTrimmedString(o.senderName, 80);
    out.senderTitle = asTrimmedString(o.senderTitle, 100);
    out.socialProof = asStringArray(o.socialProof, 10);
    if (typeof o.bookingUrl === 'string') {
      const trimmed = o.bookingUrl.trim();
      // Basic URL sanity check — must start with https://
      if (/^https:\/\/.{4,200}$/.test(trimmed)) out.bookingUrl = trimmed.slice(0, 300);
    }
    if (typeof o.defaultTone === 'string' && ['formal', 'casual', 'consultative', 'direct'].includes(o.defaultTone)) {
      out.defaultTone = o.defaultTone as CustomerICP['outreach'] extends infer U
        ? U extends { defaultTone?: infer T } ? T : never : never;
    }
    // Only keep outreach if it has at least one populated field
    if (Object.values(out).some(v => v !== undefined)) {
      icp.outreach = out;
    }
  }

  return { ok: true, icp };
}
