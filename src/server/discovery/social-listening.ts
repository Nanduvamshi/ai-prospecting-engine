/**
 * Social Listening — Phase 1 Signal 5.
 *
 * Monitors Reddit + Hacker News for explicit buying-intent queries
 * ("what CRM should I use?", "HubSpot alternative", etc.). These surface
 * people actively in the market THIS WEEK.
 *
 * Data sources (all free, no auth):
 *   - HN Algolia API (https://hn.algolia.com/api)
 *   - Reddit public JSON endpoints (no OAuth for read-only search)
 *
 * Unlike per-prospect signals, this produces NEW leads — people asking
 * publicly who we didn't know existed.
 */

export interface SocialSignal {
  source: 'reddit' | 'hackernews';
  /** Short description of intent e.g., "looking for HubSpot alternative" */
  intent: string;
  /** The quoted post/comment text */
  excerpt: string;
  /** Author username (never PII without their public consent) */
  author: string;
  /** URL to the original post */
  url: string;
  /** Unix seconds */
  postedAt: number;
  /** Subreddit or "news.ycombinator.com" */
  forum: string;
}

export interface SocialListeningResult {
  query: string;
  detectedAt: string;
  signals: SocialSignal[];
  error?: string;
}

// ─── Default buying-intent queries ───
// Tuned for CRM / sales-tool switchers. Extend based on your ICP.

export const BUYING_INTENT_QUERIES = [
  'what CRM should I use',
  'HubSpot alternative',
  'Salesforce alternative',
  'Zoho alternative',
  'Freshworks alternative',
  'best CRM for small business',
  'looking for a CRM',
  'CRM recommendations',
  'switching from HubSpot',
  'switching from Salesforce',
  'tired of HubSpot',
  'HubSpot too expensive',
];

// ─── Hacker News (Algolia) ───

interface HnAlgoliaHit {
  objectID: string;
  title?: string;
  story_title?: string;
  comment_text?: string;
  story_text?: string;
  author?: string;
  url?: string;
  story_url?: string;
  created_at_i?: number;
  _tags?: string[];
}

async function searchHackerNews(query: string, timeoutMs = 8000): Promise<SocialSignal[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=10`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const data = await response.json() as { hits?: HnAlgoliaHit[] };
    const hits = data.hits || [];
    return hits.map(h => {
      const isComment = h._tags?.includes('comment');
      const storyId = h.objectID;
      return {
        source: 'hackernews' as const,
        intent: query,
        excerpt: (h.comment_text || h.story_text || h.title || h.story_title || '').replace(/<[^>]+>/g, '').slice(0, 400),
        author: h.author || 'unknown',
        url: isComment
          ? `https://news.ycombinator.com/item?id=${storyId}`
          : (h.url || h.story_url || `https://news.ycombinator.com/item?id=${storyId}`),
        postedAt: h.created_at_i || 0,
        forum: 'news.ycombinator.com',
      };
    }).filter(s => s.excerpt.length > 10);
  } catch {
    return [];
  }
}

// ─── Reddit public search ───

interface RedditChild {
  data: {
    subreddit?: string;
    selftext?: string;
    title?: string;
    body?: string;
    author?: string;
    permalink?: string;
    created_utc?: number;
  };
}

const TARGET_SUBREDDITS = [
  'sales', 'SaaS', 'smallbusiness', 'Entrepreneur', 'startups',
  'marketing', 'CRM', 'sysadmin', 'msp',
];

async function searchReddit(query: string, timeoutMs = 8000): Promise<SocialSignal[]> {
  const signals: SocialSignal[] = [];
  const scope = TARGET_SUBREDDITS.map(s => `subreddit:${s}`).join(' OR ');
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query + ' (' + scope + ')')}&sort=new&limit=15&raw_json=1`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'prospecting-social-listener/1.0',
        Accept: 'application/json',
      },
    });
    if (!response.ok) return [];
    const data = await response.json() as { data?: { children?: RedditChild[] } };
    const children = data.data?.children || [];
    for (const child of children) {
      const d = child.data;
      if (!d) continue;
      const excerpt = (d.selftext || d.body || d.title || '').slice(0, 400);
      if (excerpt.length < 10) continue;
      signals.push({
        source: 'reddit',
        intent: query,
        excerpt,
        author: d.author || 'unknown',
        url: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
        postedAt: d.created_utc || 0,
        forum: d.subreddit ? `r/${d.subreddit}` : 'reddit.com',
      });
    }
  } catch {
    // Reddit rate-limits aggressively; silent fail is fine.
  }
  return signals;
}

// ─── Public API ───

/**
 * Search Reddit + Hacker News for a single buying-intent query.
 * Dedupes by URL. Sorts newest first.
 */
export async function searchBuyingIntent(
  query: string,
  opts: { sources?: Array<'reddit' | 'hackernews'>; timeoutMs?: number } = {},
): Promise<SocialListeningResult> {
  const sources = opts.sources || ['reddit', 'hackernews'];
  const timeoutMs = opts.timeoutMs ?? 8000;
  const now = new Date().toISOString();

  const promises: Array<Promise<SocialSignal[]>> = [];
  if (sources.includes('hackernews')) promises.push(searchHackerNews(query, timeoutMs));
  if (sources.includes('reddit')) promises.push(searchReddit(query, timeoutMs));

  const results = await Promise.allSettled(promises);
  const all: SocialSignal[] = [];
  const seenUrls = new Set<string>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const sig of r.value) {
      if (sig.url && seenUrls.has(sig.url)) continue;
      if (sig.url) seenUrls.add(sig.url);
      all.push(sig);
    }
  }
  all.sort((a, b) => b.postedAt - a.postedAt);

  return { query, detectedAt: now, signals: all };
}

/**
 * Run the default buying-intent query sweep.
 * Useful as the payload for a scheduled cron that publishes new leads
 * into the CRM's inbound queue.
 */
export async function runBuyingIntentSweep(
  opts: { queries?: string[]; timeoutMs?: number } = {},
): Promise<SocialSignal[]> {
  const queries = opts.queries || BUYING_INTENT_QUERIES;
  const timeoutMs = opts.timeoutMs ?? 8000;

  // Run in parallel but cap concurrency to be polite to both APIs.
  const batchSize = 3;
  const allSignals: SocialSignal[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(q => searchBuyingIntent(q, { timeoutMs })),
    );
    for (const r of batchResults) {
      if (r.status !== 'fulfilled') continue;
      for (const sig of r.value.signals) {
        if (sig.url && seenUrls.has(sig.url)) continue;
        if (sig.url) seenUrls.add(sig.url);
        allSignals.push(sig);
      }
    }
  }

  allSignals.sort((a, b) => b.postedAt - a.postedAt);
  return allSignals;
}
