/**
 * Email Pattern Generator
 * Generates 15+ candidate email addresses from a person's name and company domain.
 * Includes domain guessing with liveness checks.
 *
 * Based on patterns from BW_Prospecting_hub email_finder by Lakshay Trip.
 * Pattern-guessed emails should ONLY be used if verified via Bouncer/SMTP.
 */

/**
 * Extract first name and last name from a full name string.
 * Handles "John Smith", "John David Smith", "Dr. John Smith", etc.
 * Strips non-alpha chars except hyphens/apostrophes (matching Lakshay's normalize_name).
 */
function parseName(fullName: string): { first: string; last: string } | null {
  const cleaned = fullName
    .trim()
    .replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+/i, '')
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|phd|md|esq\.?)$/i, '')
    .replace(/\s+/g, ' ');

  const parts = cleaned.split(' ').filter(Boolean);
  if (parts.length < 1) return null;

  const first = parts[0].toLowerCase().replace(/[^a-z\-']/g, '');
  const last = parts.length > 1
    ? parts[parts.length - 1].toLowerCase().replace(/[^a-z\-']/g, '')
    : '';

  if (!first) return null;

  return { first, last };
}

/**
 * Extract domain from a URL or email-like string.
 * "https://acme.com/about" → "acme.com"
 * "acme.com" → "acme.com"
 */
export function extractDomain(input: string): string | null {
  if (!input) return null;

  let domain = input.trim().toLowerCase();

  // Strip protocol + path
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.split('/')[0];
  domain = domain.split('?')[0];
  domain = domain.split('#')[0];
  domain = domain.replace(/:\d+$/, ''); // Remove port

  // Basic validation
  if (!domain.includes('.') || domain.length < 4) return null;

  return domain;
}

/**
 * Check if a domain is alive by sending a HEAD request.
 * Returns true if the domain responds with a non-error status.
 */
export async function checkDomainAlive(domain: string, timeoutMs: number = 4000): Promise<boolean> {
  if (!domain) return false;

  for (const protocol of ['https', 'http']) {
    try {
      const response = await fetch(`${protocol}://${domain}`, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status < 400) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Guess a company's domain from its name by trying common TLDs.
 * Tests .com, .io, .co, .net, .ai with liveness checks.
 * Returns the first live domain found, or null.
 */
export async function guessDomainFromCompany(companyName: string): Promise<string | null> {
  if (!companyName) return null;

  // Sanitize: keep only alphanumeric and hyphens
  const base = companyName.toLowerCase().replace(/[^a-z0-9\-]/g, '');
  if (!base) return null;

  const candidates = [
    `${base}.com`,
    `${base}.io`,
    `${base}.co`,
    `${base}.net`,
    `${base}.ai`,
    `${base}.org`,
  ];

  // Check all candidates in parallel for speed
  const results = await Promise.allSettled(
    candidates.map(async (domain) => {
      const alive = await checkDomainAlive(domain, 3000);
      return alive ? domain : null;
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }

  return null;
}

export interface EmailCandidate {
  email: string;
  pattern: string;
  /** Lower = more common/likely */
  priority: number;
}

/**
 * Generate 15+ candidate email addresses for a person at a company domain.
 * Uses patterns from Lakshay's BW_Prospecting_hub:
 * - Standard patterns (first.last, first, flast, etc.)
 * - Variant patterns (first-last, f.last, first.l, etc.)
 * - Numbered fallbacks (first99, firstlast1, etc.)
 *
 * These are GUESSES — they must be verified via Bouncer API or SMTP before use.
 */
export function generateEmailCandidates(
  fullName: string,
  companyDomain: string,
): EmailCandidate[] {
  const parsed = parseName(fullName);
  if (!parsed) return [];

  const domain = extractDomain(companyDomain);
  if (!domain) return [];

  const { first, last } = parsed;
  const seen = new Set<string>();
  const candidates: EmailCandidate[] = [];

  const add = (local: string, pattern: string) => {
    const email = `${local}@${domain}`;
    if (!seen.has(email)) {
      seen.add(email);
      candidates.push({ email, pattern, priority: candidates.length });
    }
  };

  // Core patterns (high priority, most common in B2B)
  if (first) {
    add(first, 'first');
  }
  if (first && last) {
    add(`${first}.${last}`, 'first.last');
    add(`${first}_${last}`, 'first_last');
    add(`${first}-${last}`, 'first-last');
    add(`${first}${last}`, 'firstlast');
    add(`${first[0]}.${last}`, 'f.last');
    add(`${first}.${last[0]}`, 'first.l');
    add(`${last}.${first}`, 'last.first');
    add(`${first[0]}${last}`, 'flast');
    add(`${first}${last[0]}`, 'firstl');
    // Numbered variants (Lakshay's patterns)
    add(`${first}99`, 'first99');
    add(`${first}.${last}99`, 'first.last99');
    add(`${first[0]}${last}99`, 'flast99');
    add(`${first}${last}1`, 'firstlast1');
    add(`${first[0]}.${last[0]}`, 'f.l');
    add(`${first[0]}_${last}`, 'f_last');
    add(`${last}`, 'last');
    add(`${first}1`, 'first1');
  }

  // If we still have fewer than 15, add more deterministic variants
  if (first && last) {
    add(`${last}${first}`, 'lastfirst');
    add(`${last}${first[0]}`, 'lastf');
    add(`${last}.${first[0]}`, 'last.f');
    add(`${first}.${last}1`, 'first.last1');
  }

  // Pad to at least 15 with numbered variants if needed
  const baseName = first && last ? `${first}${last}` : first || domain.split('.')[0];
  let idx = 0;
  while (candidates.length < 15 && idx < 20) {
    add(`${baseName}${idx}`, `base${idx}`);
    idx++;
  }

  return candidates;
}
