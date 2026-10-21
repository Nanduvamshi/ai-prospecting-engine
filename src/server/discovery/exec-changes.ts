/**
 * Executive Changes — Phase 1 Signal 8 (Priority 2).
 *
 * Surfaces companies with recent C-level or VP-level hires/departures.
 * A new CRO/CMO/CTO creates a ~90-day "buying window" where they re-evaluate
 * the existing stack. A departing executive signals instability and possible
 * procurement freeze — also useful for timing outreach.
 *
 * Source: SerpAPI (already integrated) for Google news + LinkedIn posts.
 *
 * Per-lead enrichment; NOT a bulk-discovery feed like the social-listening
 * module. Call when you already have a target company and want timing signals.
 */

import { searchSerpApi } from './serpapi';

export type ExecRole = 'CEO' | 'CTO' | 'CRO' | 'CFO' | 'COO' | 'CMO' | 'CPO' | 'CDO' | 'VP' | 'Head';

export interface ExecChange {
  company: string;
  role: ExecRole;
  /** "appointed", "joined", "hired", "promoted" → appointment; "departs", "leaves", "steps down" → departure */
  changeType: 'appointment' | 'departure' | 'promotion';
  execName?: string;
  headline: string;
  source: string;
  url: string;
  /** Rough recency tier — exact date parsing varies by source */
  recencyTier: 'this_week' | 'this_month' | 'this_quarter' | 'older';
}

const ROLE_PATTERNS: Record<ExecRole, RegExp> = {
  CEO: /\b(?:CEO|chief executive(?:\s+officer)?)\b/i,
  CTO: /\b(?:CTO|chief technology(?:\s+officer)?|chief tech(?:\s+officer)?)\b/i,
  CRO: /\b(?:CRO|chief revenue(?:\s+officer)?)\b/i,
  CFO: /\b(?:CFO|chief financial(?:\s+officer)?)\b/i,
  COO: /\b(?:COO|chief operating(?:\s+officer)?)\b/i,
  CMO: /\b(?:CMO|chief marketing(?:\s+officer)?)\b/i,
  CPO: /\b(?:CPO|chief product(?:\s+officer)?|chief people(?:\s+officer)?)\b/i,
  CDO: /\b(?:CDO|chief data(?:\s+officer)?|chief digital(?:\s+officer)?)\b/i,
  VP: /\b(?:VP|vice president)\b/i,
  Head: /\bhead\s+of\s+[A-Za-z]+/i,
};

const APPOINTMENT_PATTERNS = /\b(?:appoints?|names?|hires?|joins?|welcomes?|elevates?|promotes?)\b/i;
const DEPARTURE_PATTERNS = /\b(?:departs?|leaves?|steps?\s+down|resigns?|exits?|parts?\s+ways)\b/i;

function classifyRole(text: string): ExecRole | null {
  // Prefer more specific C-level roles before falling back to VP / Head
  const specificOrder: ExecRole[] = ['CEO', 'CRO', 'CMO', 'CTO', 'CFO', 'COO', 'CPO', 'CDO', 'VP', 'Head'];
  for (const role of specificOrder) {
    if (ROLE_PATTERNS[role].test(text)) return role;
  }
  return null;
}

function classifyChangeType(text: string): ExecChange['changeType'] | null {
  if (DEPARTURE_PATTERNS.test(text)) return 'departure';
  if (/\bpromotes?\b/i.test(text)) return 'promotion';
  if (APPOINTMENT_PATTERNS.test(text)) return 'appointment';
  return null;
}

function parseExecName(headline: string, company: string): string | undefined {
  // Heuristic: look for "appoints <Name> as <Role>" or "<Name> joins <Company>"
  const asMatch = headline.match(/(?:appoints|names|hires|welcomes)\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,3})\s+(?:as|to)\b/);
  if (asMatch?.[1]) return asMatch[1];
  const joinsMatch = headline.match(/\b([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,3})\s+joins\b/);
  if (joinsMatch?.[1] && !joinsMatch[1].toLowerCase().includes(company.toLowerCase())) return joinsMatch[1];
  return undefined;
}

function classifyRecency(snippetAndTitle: string): ExecChange['recencyTier'] {
  const lower = snippetAndTitle.toLowerCase();
  if (/\b(?:today|yesterday|this week|days ago)\b/.test(lower)) return 'this_week';
  if (/\b(?:this month|weeks ago|recently)\b/.test(lower)) return 'this_month';
  if (/\b(?:this quarter|months ago|earlier this year)\b/.test(lower)) return 'this_quarter';
  return 'older';
}

/**
 * Detect recent executive changes at a specific company.
 *
 * Fires 2 parallel SerpAPI queries (appointments + departures), parses
 * headlines, and returns classified change events.
 */
export async function detectExecChanges(companyName: string): Promise<ExecChange[]> {
  if (!companyName) return [];

  const queries = [
    `"${companyName}" (appoints OR names OR hires) (CEO OR CRO OR CMO OR CTO OR CFO OR COO OR VP) 2025 OR 2026`,
    `"${companyName}" (departs OR "steps down" OR resigns) (CEO OR CRO OR CMO OR CTO OR CFO OR COO) 2025 OR 2026`,
    `"${companyName}" new (CEO OR CRO OR CMO OR CTO)`,
  ];

  const searches = await Promise.allSettled(
    queries.map(q => searchSerpApi(q, { num: 5 })),
  );

  const changes: ExecChange[] = [];
  const seenUrls = new Set<string>();

  for (const result of searches) {
    if (result.status !== 'fulfilled') continue;
    for (const hit of result.value) {
      if (!hit.url || seenUrls.has(hit.url)) continue;
      const combined = `${hit.title || ''} ${hit.snippet || ''}`;
      const role = classifyRole(combined);
      const changeType = classifyChangeType(combined);
      if (!role || !changeType) continue;

      // Require the company name to appear in the title/snippet to avoid tangential hits
      if (!new RegExp(`\\b${companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(combined)) continue;

      let host = '';
      try { host = new URL(hit.url).hostname; } catch { /* ignore */ }

      seenUrls.add(hit.url);
      changes.push({
        company: companyName,
        role,
        changeType,
        execName: parseExecName(hit.title || '', companyName),
        headline: hit.title || combined.slice(0, 200),
        source: host,
        url: hit.url,
        recencyTier: classifyRecency(combined),
      });
    }
  }

  // Sort: freshest first
  const recencyRank: Record<ExecChange['recencyTier'], number> = {
    this_week: 0, this_month: 1, this_quarter: 2, older: 3,
  };
  changes.sort((a, b) => recencyRank[a.recencyTier] - recencyRank[b.recencyTier]);

  return changes;
}

/**
 * Yes/no: does this company have an exec change fresh enough to create a
 * buying window right now?
 */
export async function hasRecentExecChange(companyName: string): Promise<boolean> {
  const changes = await detectExecChanges(companyName);
  return changes.some(c => c.recencyTier === 'this_week' || c.recencyTier === 'this_month');
}
