/**
 * Funding Signals — Phase 1 Signal 7 (Priority 2).
 *
 * Surfaces companies that recently raised — strong buying signal
 * (budget unlocked, scaling teams, adding tools).
 *
 * Free sources:
 *   - TechCrunch / VentureBeat / SaaStr RSS feeds
 *   - SEC EDGAR full-text search for S-1 and 8-K filings (US public or
 *     pre-IPO companies)
 *
 * Non-goal: not replicating Crunchbase's full dataset. Just the recent
 * announcements that hit public news feeds.
 */

export interface FundingAnnouncement {
  company: string;
  headline: string;
  amount?: string;
  round?: string;
  publishedAt: string;
  source: string;
  url: string;
}

// ─── RSS fetch + parse ───

const RSS_SOURCES = [
  { name: 'TechCrunch Funding', url: 'https://techcrunch.com/category/venture/feed/' },
  { name: 'TechCrunch Startups', url: 'https://techcrunch.com/category/startups/feed/' },
];

// Unified action verb for funding headlines. Covers present+past tense and the
// most common adjacent verbs ("closes", "secures", "lands", "nets"). Without
// the past tense, TechCrunch headlines like "Pillar raised $20M seed" would
// all fail to match.
const FUNDING_VERB = '(?:raises|raised|closes|closed|secures|secured|lands|landed|nets|netted)';
const AMOUNT = '\\$?([\\d.]+\\s*[MB]?)';

const FUNDING_HEADLINE_PATTERNS = [
  { round: 'Seed', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?seed\\b`, 'i') },
  { round: 'Pre-Seed', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?pre[-\\s]?seed\\b`, 'i') },
  { round: 'Series A', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?series\\s+a\\b`, 'i') },
  { round: 'Series B', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?series\\s+b\\b`, 'i') },
  { round: 'Series C', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?series\\s+c\\b`, 'i') },
  { round: 'Series D', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?series\\s+d\\b`, 'i') },
  { round: 'Growth', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\s*(?:in\\s+)?growth\\b`, 'i') },
  // Catch-all: funding headline without an explicit round label. Headlines
  // like "Accel raises $5B to back late-stage bets" or "Pillar raises $95M
  // fund" should still surface as funding signals. Must come LAST so
  // explicit-round matches win.
  { round: 'Unspecified', pattern: new RegExp(`\\b${FUNDING_VERB}\\s+${AMOUNT}\\b`, 'i') },
];

// Rough "Company raises $X…" headline → extract company name (first quoted
// word or up-to "raises"). Good enough for TechCrunch-style headlines;
// long-term this should feed Claude for cleaner extraction.
function parseCompanyFromHeadline(headline: string): string | null {
  const cleaned = headline.replace(/\s+/g, ' ').trim();
  const beforeVerb = cleaned.match(/^(.+?)\s+(?:raises|raised|announces|announced|closes|closed|secures|secured|lands|landed|nets|netted)\b/i);
  if (beforeVerb?.[1]) return beforeVerb[1].trim();
  return null;
}

function classifyRound(headline: string): { round?: string; amount?: string } {
  for (const { round, pattern } of FUNDING_HEADLINE_PATTERNS) {
    const m = headline.match(pattern);
    if (m) return { round, amount: m[1] };
  }
  return {};
}

async function fetchRss(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'prospecting-funding-monitor/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/))?.[1]?.trim() || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1]?.trim() || '';
    const description = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || block.match(/<description>([\s\S]*?)<\/description>/))?.[1]?.trim() || '';
    if (title) items.push({ title, link, pubDate, description });
  }
  return items;
}

/**
 * Poll all configured RSS feeds and extract funding announcements from the past N days.
 */
export async function fetchRecentFundingAnnouncements(
  opts: { sinceDays?: number } = {},
): Promise<FundingAnnouncement[]> {
  const sinceMs = Date.now() - ((opts.sinceDays || 7) * 24 * 60 * 60 * 1000);
  const announcements: FundingAnnouncement[] = [];

  const feedResults = await Promise.allSettled(
    RSS_SOURCES.map(async (src) => {
      const xml = await fetchRss(src.url);
      if (!xml) return { src, items: [] };
      return { src, items: parseRssItems(xml) };
    }),
  );

  for (const r of feedResults) {
    if (r.status !== 'fulfilled') continue;
    const { src, items } = r.value;
    for (const item of items) {
      const publishedMs = Date.parse(item.pubDate || '') || Date.now();
      if (publishedMs < sinceMs) continue;
      const { round, amount } = classifyRound(item.title);
      if (!round) continue; // Not a funding headline
      const company = parseCompanyFromHeadline(item.title);
      if (!company) continue;
      announcements.push({
        company,
        headline: item.title,
        amount,
        round,
        publishedAt: new Date(publishedMs).toISOString(),
        source: src.name,
        url: item.link,
      });
    }
  }

  announcements.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return announcements;
}

// ─── SEC EDGAR ───
// Free full-text search for S-1 / 8-K filings.
// Docs: https://www.sec.gov/edgar/search/
// Rate limit: 10 req/s — plenty for periodic polls.

export interface EdgarFiling {
  cik: string;
  company: string;
  formType: string;
  filedAt: string;
  url: string;
}

async function fetchEdgarFilings(formType: 'S-1' | '8-K', sinceDays = 30): Promise<EdgarFiling[]> {
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '');
  // EDGAR's full-text JSON API
  const url = `https://efts.sec.gov/LATEST/search-index?q=&dateRange=custom&startdt=${dateFrom}&forms=${encodeURIComponent(formType)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': `prospecting-sec-monitor ${process.env.SEC_CONTACT_EMAIL ?? 'contact@example.com'}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { hits?: { hits?: Array<{ _source?: Record<string, unknown>; _id?: string }> } };
    const rows = data?.hits?.hits || [];
    return rows.slice(0, 50).map(r => {
      const src = r._source || {};
      const accessionNo = String((src.adsh as string) || '');
      const accParts = accessionNo.split('-');
      return {
        cik: String(src.ciks ? (Array.isArray(src.ciks) ? src.ciks[0] : src.ciks) : ''),
        company: Array.isArray(src.display_names) ? String(src.display_names[0]).split('(CIK')[0].trim() : String((src.display_names as string) || ''),
        formType: String((src.form as string) || formType),
        filedAt: String((src.file_date as string) || ''),
        url: accParts.length >= 3
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(src.ciks ? (Array.isArray(src.ciks) ? src.ciks[0] : src.ciks) : '')}&type=${formType}`
          : 'https://www.sec.gov/cgi-bin/browse-edgar',
      };
    });
  } catch {
    return [];
  }
}

export async function fetchRecentIpoFilings(sinceDays = 30): Promise<EdgarFiling[]> {
  return fetchEdgarFilings('S-1', sinceDays);
}

export async function fetchRecentMaterialEvents(sinceDays = 7): Promise<EdgarFiling[]> {
  return fetchEdgarFilings('8-K', sinceDays);
}
