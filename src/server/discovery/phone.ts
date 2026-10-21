import 'server-only';

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * One place that decides whether a string is a phone number.
 *
 * There were three hand-rolled normalisers before this, none agreeing: one in
 * contact-validation that only understood +91, another in brightdata that only
 * understood +91 differently, and two more for deduplication. Between them they
 * let `026-02-152026` through as a phone number — an 11-digit string that fell
 * into a gap between the North-American branch (which wants a leading 1) and a
 * length guard that only fired above 11 digits.
 *
 * Region matters as much as format. The old code asked "is this lead Indian and
 * is this a US number?", so for an Australian lead the test was false and *any*
 * number was accepted — which is how a Miami switchboard ended up on a Sydney
 * restaurant owner.
 */

/** Region hint used when a number has no country code of its own. */
export type PhoneRegion = CountryCode;

export interface NormalizedPhone {
  /** E.164, e.g. +61404086264. */
  e164: string;
  /** ISO country the number belongs to, when known. */
  country?: string;
  /** True when the number is a plausible line for that country, not just parseable. */
  valid: boolean;
}

/**
 * Parse a phone number, returning E.164 or null.
 *
 * Strict by default: parsing alone is not enough, because the library will
 * happily turn a malformed date into `+612602152026`. Only numbers that are
 * valid for their country are returned.
 */
export function normalizePhone(
  raw: string | undefined | null,
  region?: PhoneRegion,
): string | null {
  const parsed = parsePhone(raw, region);
  return parsed?.valid ? parsed.e164 : null;
}

/** Full detail, for callers that want to know the country or log a rejection. */
export function parsePhone(
  raw: string | undefined | null,
  region?: PhoneRegion,
): NormalizedPhone | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = parsePhoneNumberFromString(trimmed, region);
    if (!parsed) return null;
    return {
      e164: parsed.number,
      country: parsed.country,
      valid: parsed.isValid(),
    };
  } catch {
    return null;
  }
}

/**
 * Does this number belong to the region we expect?
 *
 * Used to reject a switchboard picked up from an unrelated page. When no region
 * is expected the answer is yes — an unbiased run should not discard numbers.
 */
export function matchesRegion(raw: string, region?: PhoneRegion): boolean {
  if (!region) return true;
  const parsed = parsePhone(raw, region);
  return Boolean(parsed?.valid && parsed.country === region);
}

/** Bare digits, for matching two records rather than for display or dialling. */
export function phoneFingerprint(raw: string): string {
  return raw.replace(/\D/g, '').slice(-10);
}
