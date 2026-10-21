/**
 * Contact Graph — identity + dedup primitives.
 *
 * Every contact record is keyed by `sha256(normalizedEmail)`. This:
 *   1. Enables O(1) lookups by email without storing the email in the PK (mild
 *      privacy win — the raw email never appears in a key).
 *   2. Collapses `John@Acme.COM` vs `john@acme.com` automatically via
 *      normalization before hashing.
 *
 * Secondary matching (for dedup merges) uses normalized phone + linkedinUrl.
 */

import { createHash } from 'crypto';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function contactHashForEmail(email: string): string {
  const normalized = normalizeEmail(email);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7) return undefined;
  return digits;
}

export function normalizeLinkedin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().toLowerCase();
  // Extract the /in/<handle> or /company/<handle> segment
  const m = trimmed.match(/linkedin\.com\/(in|company|pub)\/([^/?#]+)/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function normalizeCompany(company: string | undefined): string | undefined {
  if (!company) return undefined;
  // Strip common corporate suffixes, collapse whitespace
  return company
    .trim()
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|plc)\.?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Merge two contact records that represent the same person.
 * Returns a new record; does not mutate inputs.
 *
 * Rules:
 *  - Newer field values win over older ones
 *  - sightingCount = sum
 *  - firstSeenAt = earlier
 *  - lastSeenAt, lastVerifiedAt = later
 *  - confidenceScore = max(both) (capped at 100)
 */
export function mergeContacts<
  T extends {
    name?: string; title?: string; company?: string; companyDomain?: string;
    phone?: string; linkedinUrl?: string;
    confidenceScore: number; firstSeenAt: string; lastSeenAt: string;
    lastVerifiedAt?: string; sightingCount: number;
  },
>(a: T, b: T): T {
  const newer = a.lastSeenAt > b.lastSeenAt ? a : b;
  const older = a.lastSeenAt > b.lastSeenAt ? b : a;
  const pickMostRecent = <K extends keyof T>(key: K) => newer[key] ?? older[key];

  return {
    ...older,
    ...newer,
    name: pickMostRecent('name'),
    title: pickMostRecent('title'),
    company: pickMostRecent('company'),
    companyDomain: pickMostRecent('companyDomain'),
    phone: pickMostRecent('phone'),
    linkedinUrl: pickMostRecent('linkedinUrl'),
    sightingCount: (a.sightingCount || 0) + (b.sightingCount || 0),
    firstSeenAt: a.firstSeenAt < b.firstSeenAt ? a.firstSeenAt : b.firstSeenAt,
    lastSeenAt: a.lastSeenAt > b.lastSeenAt ? a.lastSeenAt : b.lastSeenAt,
    lastVerifiedAt:
      (a.lastVerifiedAt || '') > (b.lastVerifiedAt || '') ? a.lastVerifiedAt : b.lastVerifiedAt,
    confidenceScore: Math.min(100, Math.max(a.confidenceScore, b.confidenceScore)),
  };
}
