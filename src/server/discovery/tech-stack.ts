/**
 * Tech Stack Detection — lightweight Wappalyzer-style fingerprinting.
 *
 * Fetches a company's homepage HTML and pattern-matches against known
 * technology signatures (scripts, meta tags, HTTP headers, cookies).
 *
 * Primary use: CRM competitor detection. If a prospect uses HubSpot/
 * Salesforce/Zoho/Freshworks/Intercom/Pipedrive/Monday/Close/Copper, they
 * are a qualified switching target.
 *
 * No external dependency — uses regex fingerprints against raw HTML.
 * See https://github.com/wappalyzer/wappalyzer for the canonical fingerprint DB.
 *
 * Part of Phase 1 Priority 1 intent signals (Nitya-ranked).
 */

export type DetectedTech = {
  name: string;
  category: TechCategory;
  /** Which pattern matched — useful for debugging false positives */
  evidence: string;
};

export type TechCategory =
  | 'crm'
  | 'helpdesk'
  | 'marketing_automation'
  | 'live_chat'
  | 'analytics'
  | 'email_marketing'
  | 'scheduling'
  | 'cms'
  | 'ecommerce';

export interface TechStackResult {
  domain: string;
  detectedAt: string;
  /** All technologies detected on the site */
  technologies: DetectedTech[];
  /** Just the CRM competitors — subset of technologies */
  competitors: DetectedTech[];
  /** True if fetch failed; other fields will be empty */
  error?: string;
}

// ─── Fingerprint definitions ───
// Each entry: pattern matched against HTML (scripts, meta, head)
// Keep these minimal and specific — broad patterns cause false positives.

interface Fingerprint {
  name: string;
  category: TechCategory;
  /** Regex patterns; any match counts */
  patterns: RegExp[];
}

// CRM competitors — the product replaces these. Highest-intent signal.
const CRM_COMPETITORS: Fingerprint[] = [
  {
    name: 'HubSpot',
    category: 'crm',
    patterns: [
      /js\.hs-scripts\.com/i,
      /js\.hsadspixel\.net/i,
      /js\.hs-analytics\.net/i,
      /hubspot\.com\/.+hub/i,
      /<script[^>]+src=["'][^"']*hubspot/i,
      /_hsq\s*=/,
    ],
  },
  {
    name: 'Salesforce',
    category: 'crm',
    patterns: [
      /salesforce\.com\/.+\/livechat/i,
      /force\.com/i,
      /lightning\.force\.com/i,
      /sforce\.com/i,
      /salesforce_chat/i,
    ],
  },
  {
    name: 'Zoho CRM',
    category: 'crm',
    patterns: [
      /crm\.zoho\.com/i,
      /zohoapis\.com/i,
      /zohostatic\.com/i,
      /_zcfa\s*=/,
      /<script[^>]+src=["'][^"']*zoho/i,
    ],
  },
  {
    name: 'Freshworks',
    category: 'crm',
    patterns: [
      /freshworks\.com/i,
      /freshsales\.io/i,
      /fwhub\.com/i,
      /crm\.freshworks\.com/i,
      /<script[^>]+src=["'][^"']*freshchat/i,
    ],
  },
  {
    name: 'Pipedrive',
    category: 'crm',
    patterns: [
      /pipedrive\.com/i,
      /pipedriveassets\.com/i,
      /<script[^>]+src=["'][^"']*pipedrive/i,
    ],
  },
  {
    name: 'Monday.com',
    category: 'crm',
    patterns: [
      /monday\.com/i,
      /cdn\.monday\.com/i,
      /<meta[^>]+content=["'][^"']*monday\.com/i,
    ],
  },
  {
    name: 'Close',
    category: 'crm',
    patterns: [
      /\.close\.com/i,
      /close\.io/i,
      /app\.close\.com/i,
    ],
  },
  {
    name: 'Copper',
    category: 'crm',
    patterns: [
      /copper\.com/i,
      /prosperworks\.com/i,
    ],
  },
  {
    name: 'ActiveCampaign',
    category: 'crm',
    patterns: [
      /activecampaign\.com/i,
      /activehosted\.com/i,
      /<script[^>]+src=["'][^"']*activecampaign/i,
    ],
  },
  {
    name: 'Keap',
    category: 'crm',
    patterns: [
      /keap\.com/i,
      /infusionsoft\.com/i,
    ],
  },
];

// Help-desk competitors (the product has unified inbox + ticketing)
const HELPDESK_COMPETITORS: Fingerprint[] = [
  {
    name: 'Zendesk',
    category: 'helpdesk',
    patterns: [/zendesk\.com/i, /zdassets\.com/i, /<script[^>]+src=["'][^"']*zdchat/i],
  },
  {
    name: 'Freshdesk',
    category: 'helpdesk',
    patterns: [/freshdesk\.com/i, /freshcaller\.com/i],
  },
  {
    name: 'Help Scout',
    category: 'helpdesk',
    patterns: [/helpscout\.net/i, /beacon-v2\.helpscout\.net/i],
  },
  {
    name: 'Intercom',
    category: 'helpdesk',
    patterns: [
      /widget\.intercom\.io/i,
      /js\.intercomcdn\.com/i,
      /intercomcdn\.com/i,
      /<script[^>]+src=["'][^"']*intercom/i,
    ],
  },
];

// Live-chat widgets (often paired with CRMs, buying intent signal)
const LIVE_CHAT_TOOLS: Fingerprint[] = [
  { name: 'Drift', category: 'live_chat', patterns: [/widget\.drift\.com/i, /js\.driftt\.com/i] },
  { name: 'Tawk.to', category: 'live_chat', patterns: [/embed\.tawk\.to/i, /tawk\.to/i] },
  { name: 'Crisp', category: 'live_chat', patterns: [/client\.crisp\.chat/i, /crisp\.chat/i] },
  { name: 'LiveChat', category: 'live_chat', patterns: [/cdn\.livechatinc\.com/i] },
  { name: 'Olark', category: 'live_chat', patterns: [/static\.olark\.com/i] },
];

// Marketing automation (buying signal — they're investing in comms tooling)
const MARKETING_AUTOMATION: Fingerprint[] = [
  { name: 'Marketo', category: 'marketing_automation', patterns: [/mktoresp\.com/i, /munchkin\.marketo\.net/i] },
  { name: 'Pardot', category: 'marketing_automation', patterns: [/pi\.pardot\.com/i, /pardot\.com/i] },
  { name: 'Mailchimp', category: 'email_marketing', patterns: [/mailchimp\.com/i, /chimpstatic\.com/i, /<script[^>]+src=["'][^"']*mailchimp/i] },
  { name: 'Klaviyo', category: 'email_marketing', patterns: [/static\.klaviyo\.com/i, /klaviyo\.com/i] },
  { name: 'ConvertKit', category: 'email_marketing', patterns: [/convertkit\.com/i, /<script[^>]+src=["'][^"']*convertkit/i] },
];

// Scheduling (often paired with sales tools)
const SCHEDULING_TOOLS: Fingerprint[] = [
  { name: 'Calendly', category: 'scheduling', patterns: [/assets\.calendly\.com/i, /calendly\.com\/embed/i] },
  { name: 'Chili Piper', category: 'scheduling', patterns: [/chilipiper\.com/i, /cdn\.chilipiper\.com/i] },
];

const ALL_FINGERPRINTS: Fingerprint[] = [
  ...CRM_COMPETITORS,
  ...HELPDESK_COMPETITORS,
  ...LIVE_CHAT_TOOLS,
  ...MARKETING_AUTOMATION,
  ...SCHEDULING_TOOLS,
];

// ─── Detection ───

function matchFingerprints(html: string, fingerprints: Fingerprint[]): DetectedTech[] {
  const detected: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const fp of fingerprints) {
    for (const pattern of fp.patterns) {
      const match = html.match(pattern);
      if (match && !seen.has(fp.name)) {
        seen.add(fp.name);
        detected.push({
          name: fp.name,
          category: fp.category,
          evidence: (match[0] || '').slice(0, 120),
        });
        break; // One pattern match per fingerprint is enough
      }
    }
  }

  return detected;
}

async function fetchHomepage(domain: string, timeoutMs = 8000): Promise<string | null> {
  let url = domain.trim();
  if (!url.startsWith('http')) url = `https://${url}`;

  for (const candidate of [url, url.replace(/^https:/, 'http:')]) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; prospecting-tech-detector/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > 500) return text;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Detect technology stack on a company's homepage.
 * Returns detected technologies + the subset that are CRM competitors
 * (qualified switching targets for sales).
 */
export async function detectTechStack(
  domain: string,
  timeoutMs = 8000,
): Promise<TechStackResult> {
  const now = new Date().toISOString();

  if (!domain) {
    return { domain, detectedAt: now, technologies: [], competitors: [], error: 'no domain' };
  }

  const html = await fetchHomepage(domain, timeoutMs);
  if (!html) {
    return { domain, detectedAt: now, technologies: [], competitors: [], error: 'fetch failed' };
  }

  const technologies = matchFingerprints(html, ALL_FINGERPRINTS);
  const competitors = technologies.filter(t => t.category === 'crm' || t.category === 'helpdesk');

  return { domain, detectedAt: now, technologies, competitors };
}

/**
 * Quick yes/no check: does this domain use any known competitors?
 * Short-circuits on first match. Use when you just need the boolean.
 */
export async function usesCompetitor(domain: string): Promise<boolean> {
  const result = await detectTechStack(domain);
  return result.competitors.length > 0;
}
