/**
 * New Domain Registrations — Phase 1 Signal 9 (Priority 2).
 *
 * Surfaces newly-registered domains that match an ICP keyword set.
 * A brand-new domain with "CRM" / "sales" / "clinic" in the name often
 * signals a new company being born — early-mover targeting.
 *
 * Sources (all free):
 *   - crt.sh certificate transparency logs (https://crt.sh)
 *     Every TLS cert issued for a domain appears here. Querying wildcard
 *     patterns surfaces newly-issued certs, which are a strong proxy for
 *     newly-live domains.
 *   - Reverse-DNS sweeps on curated IP ranges (out of scope for MVP)
 *
 * crt.sh is slow and rate-limited; use sparingly or behind a cache.
 */

export interface NewDomainMatch {
  domain: string;
  /** Which ICP keyword matched */
  matchedKeyword: string;
  /** ISO timestamp — first certificate issuance date */
  firstSeenAt: string;
  /** Issuer CA name from the cert log */
  issuer?: string;
}

export interface DomainMonitorResult {
  keyword: string;
  detectedAt: string;
  matches: NewDomainMatch[];
  error?: string;
}

// Default ICP keywords — tune to what your customer base sells to.
export const DEFAULT_ICP_KEYWORDS = [
  'crm', 'sales', 'revops', 'agency', 'studio', 'clinic', 'wellness',
  'legal', 'advisory', 'consulting', 'labs', 'health', 'logistics',
];

interface CrtShEntry {
  issuer_ca_id: number;
  issuer_name: string;
  common_name: string;
  name_value: string;
  id: number;
  entry_timestamp: string;
  not_before: string;
  not_after: string;
}

async function queryCrtSh(keyword: string, timeoutMs = 15000): Promise<CrtShEntry[]> {
  const query = `%${keyword}%`;
  const url = `https://crt.sh/?q=${encodeURIComponent(query)}&output=json`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'prospecting-domain-monitor/1.0',
        Accept: 'application/json',
      },
    });
    if (!response.ok) return [];
    return await response.json() as CrtShEntry[];
  } catch {
    return [];
  }
}

function extractDomainsFromEntry(entry: CrtShEntry): string[] {
  // name_value is newline-separated; can include wildcards and SANs
  return (entry.name_value || '')
    .split(/\s+/)
    .map(n => n.trim().toLowerCase())
    .filter(n => n && !n.startsWith('*.'))
    .filter(n => /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(n));
}

/**
 * Find newly-certified domains matching an ICP keyword.
 *
 * Within the last N days (default 30), which brand-new domains contain
 * the keyword? Dedupes by base domain.
 */
export async function findNewDomains(
  keyword: string,
  opts: { sinceDays?: number } = {},
): Promise<DomainMonitorResult> {
  const sinceMs = Date.now() - ((opts.sinceDays || 30) * 24 * 60 * 60 * 1000);
  const now = new Date().toISOString();

  const entries = await queryCrtSh(keyword);
  if (entries.length === 0) {
    return { keyword, detectedAt: now, matches: [], error: 'no results or rate-limited' };
  }

  const seen = new Map<string, NewDomainMatch>();
  for (const entry of entries) {
    const issuedAtMs = Date.parse(entry.not_before || entry.entry_timestamp || '');
    if (!issuedAtMs || issuedAtMs < sinceMs) continue;

    for (const domain of extractDomainsFromEntry(entry)) {
      if (!domain.toLowerCase().includes(keyword.toLowerCase())) continue;
      // Only pick the earliest cert for each domain to avoid duplicate noise
      const existing = seen.get(domain);
      if (existing && existing.firstSeenAt < new Date(issuedAtMs).toISOString()) continue;
      seen.set(domain, {
        domain,
        matchedKeyword: keyword,
        firstSeenAt: new Date(issuedAtMs).toISOString(),
        issuer: entry.issuer_name,
      });
    }
  }

  const matches = Array.from(seen.values()).sort(
    (a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
  return { keyword, detectedAt: now, matches };
}

/**
 * Sweep multiple ICP keywords, aggregate, dedupe.
 * Runs keywords serially to stay inside crt.sh's informal rate limits.
 */
export async function runDomainKeywordSweep(
  keywords: string[] = DEFAULT_ICP_KEYWORDS,
  opts: { sinceDays?: number } = {},
): Promise<NewDomainMatch[]> {
  const all = new Map<string, NewDomainMatch>();
  for (const kw of keywords) {
    const result = await findNewDomains(kw, opts);
    for (const match of result.matches) {
      if (!all.has(match.domain) || all.get(match.domain)!.firstSeenAt > match.firstSeenAt) {
        all.set(match.domain, match);
      }
    }
    // Be polite to crt.sh
    await new Promise(r => setTimeout(r, 1500));
  }
  return Array.from(all.values()).sort(
    (a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
}
