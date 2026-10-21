/**
 * Catch-All Domain Detection
 *
 * Detects if a domain accepts ALL email addresses (catch-all mailbox).
 * Prevents false positives from SMTP verification on catch-all domains.
 *
 * Strategy: Try 3 random fake addresses. If all verify, it's catch-all.
 */

import { verifyEmail } from './email-verification';

const CACHE = new Map<string, { isCatchAll: boolean; checkedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if a domain has catch-all configured.
 * Caches results to avoid repeated checks.
 */
export async function isCatchAllDomain(domain: string): Promise<boolean> {
  const cached = CACHE.get(domain);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
    return cached.isCatchAll;
  }

  try {
    // Generate 3 random fake email addresses
    const fakeEmails = [
      `nonexistent${Math.random().toString(36).substring(7)}@${domain}`,
      `fake${Date.now()}@${domain}`,
      `test${Math.floor(Math.random() * 999999)}@${domain}`,
    ];

    // Verify all 3 fake addresses
    const results = await Promise.all(
      fakeEmails.map(email =>
        verifyEmail(email, 5000).catch(() => 'error' as const)
      )
    );

    // If 2+ fake addresses verify, it's catch-all
    const verifiedCount = results.filter(r => r === 'verified').length;
    const isCatchAll = verifiedCount >= 2;

    CACHE.set(domain, { isCatchAll, checkedAt: Date.now() });
    return isCatchAll;
  } catch {
    // On error, assume NOT catch-all (conservative)
    return false;
  }
}

/**
 * Enhanced email verification that accounts for catch-all domains.
 * Returns confidence level based on catch-all status.
 */
export async function verifyEmailSmart(
  email: string,
  domain: string
): Promise<{ verified: boolean; confidence: 'high' | 'medium' | 'low' }> {
  const result = await verifyEmail(email, 6000);

  if (result !== 'verified') {
    return { verified: false, confidence: 'low' };
  }

  // Email verified, but check if domain is catch-all
  const isCatchAll = await isCatchAllDomain(domain);

  if (isCatchAll) {
    // Verified but on catch-all domain = medium confidence
    return { verified: true, confidence: 'medium' };
  }

  // Verified on non-catch-all domain = high confidence
  return { verified: true, confidence: 'high' };
}
