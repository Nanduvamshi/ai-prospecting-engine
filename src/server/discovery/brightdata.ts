/**
 * BrightData Web Scraper Client for Lead Contact Enrichment
 * Uses BrightData's Web Scraper API (synchronous) to scrape LinkedIn profiles
 * and enrich leads with email, phone, social media links, and profile photos.
 *
 * Sync endpoint: POST /datasets/v3/scrape — returns results directly (1 min timeout)
 * If timeout: returns 202 + snapshot_id, then we poll for results
 *
 * Also includes email enrichment fallbacks:
 * - Company contact page scraping
 * - Email pattern inference from company domain
 */

import { BRIGHTDATA_CONFIG } from './config';
import { scrapeUrl } from '@/server/ai/web-scraper';
import { isScraperPoolConfigured, scrapeViaPool } from './scraper-pool-client';
import { validateContactData } from './contact-validation';

// ============================================
// TYPES
// ============================================

export interface BrightDataEnrichmentInput {
  name: string;
  company?: string;
  linkedinUrl?: string;
  website?: string;
}

export interface BrightDataEnrichmentResult {
  email?: string;
  phone?: string;
  twitterUrl?: string;
  githubUrl?: string;
  facebookUrl?: string;
  avatar?: string;
  location?: string;
}

// ============================================
// CONFIG CHECK
// ============================================

export function isBrightDataConfigured(): boolean {
  return BRIGHTDATA_CONFIG.IS_CONFIGURED;
}

// ============================================
// SCRAPER API
// ============================================

/**
 * Scrape LinkedIn profiles using BrightData's synchronous endpoint.
 * Only processes leads that have a LinkedIn URL (scraper requires URL input).
 *
 * Uses sync endpoint first (returns data within 1 min).
 * Falls back to async polling if the scrape takes longer.
 */
async function scrapeLinkedInProfiles(
  urls: string[]
): Promise<Record<string, unknown>[]> {
  const apiToken = BRIGHTDATA_CONFIG.API_TOKEN;
  if (!apiToken) {
    throw new Error('BrightData API token not configured');
  }

  const scraperId = BRIGHTDATA_CONFIG.SCRAPER_ID;
  const input = urls.map(url => ({ url }));

  // Try synchronous endpoint first
  const response = await fetch(
    `${BRIGHTDATA_CONFIG.API_URL}/scrape?dataset_id=${scraperId}&format=json&include_errors=true`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }
  );

  // 200 = results ready immediately
  if (response.status === 200) {
    return await response.json();
  }

  // 202 = processing, need to poll
  if (response.status === 202) {
    const data = await response.json();
    const snapshotId = data.snapshot_id;
    if (!snapshotId) {
      throw new Error('BrightData returned 202 but no snapshot_id');
    }
    return await pollSnapshotResults(snapshotId, 45000);
  }

  const text = await response.text();
  throw new Error(`BrightData scrape failed (${response.status}): ${text}`);
}

/**
 * Poll for async snapshot results with timeout.
 */
async function pollSnapshotResults(
  snapshotId: string,
  maxWaitMs: number = 45000
): Promise<Record<string, unknown>[]> {
  const apiToken = BRIGHTDATA_CONFIG.API_TOKEN;
  const startTime = Date.now();
  const pollInterval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    const statusRes = await fetch(
      `${BRIGHTDATA_CONFIG.API_URL}/snapshot/${snapshotId}?format=json`,
      {
        headers: { 'Authorization': `Bearer ${apiToken}` },
      }
    );

    if (statusRes.status === 200) {
      return await statusRes.json();
    }

    if (statusRes.status === 202) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }

    const text = await statusRes.text();
    throw new Error(`BrightData poll failed (${statusRes.status}): ${text}`);
  }

  console.warn(`BrightData scrape timed out after ${maxWaitMs}ms for snapshot ${snapshotId}`);
  return [];
}

// ============================================
// RESULT MAPPING (matches actual BrightData LinkedIn People scraper output)
// ============================================

/**
 * Map raw BrightData scraper results to our enrichment format.
 * Based on actual scraper output structure:
 * - avatar: LinkedIn profile photo URL
 * - city/location: location info
 * - bio_links: array with {link, type} objects (may contain email/website)
 * - No direct email/phone fields in LinkedIn People scraper
 *
 * Applies validation to filter out fake/placeholder contact data.
 */
function mapScraperResult(raw: Record<string, unknown>): BrightDataEnrichmentResult {
  const rawEmail = extractEmail(raw);
  const rawPhone = extractPhone(raw);

  // Validate contact data before returning
  const validated = validateContactData(rawEmail, rawPhone);

  return {
    email: validated.email,
    phone: validated.phone,
    twitterUrl: extractSocialUrl(raw, 'twitter') || extractSocialUrl(raw, 'x.com'),
    githubUrl: extractSocialUrl(raw, 'github'),
    facebookUrl: extractSocialUrl(raw, 'facebook'),
    avatar: extractAvatar(raw),
    location: extractString(raw, ['city', 'location', 'country']),
  };
}

/** Extract avatar URL from BrightData result */
function extractAvatar(obj: Record<string, unknown>): string | undefined {
  const avatar = obj.avatar;
  if (typeof avatar === 'string' && avatar.startsWith('http') && !obj.default_avatar) {
    return avatar;
  }
  // Also check profile_pic, profile_image variants
  return extractString(obj, ['profile_pic', 'profile_image', 'profile_photo', 'image_url']);
}

/** Extract email from multiple sources in BrightData result */
function extractEmail(obj: Record<string, unknown>): string | undefined {
  // Direct email fields
  const directEmail = extractString(obj, [
    'email', 'work_email', 'personal_email', 'contact_email', 'email_address',
  ]);
  if (directEmail && isValidEmail(directEmail) && !isGenericOrPlaceholderEmail(directEmail)) return directEmail;

  // Check bio_links array for email links
  if (Array.isArray(obj.bio_links)) {
    for (const link of obj.bio_links as Array<Record<string, unknown>>) {
      const url = link.link || link.url;
      if (typeof url === 'string') {
        if (url.startsWith('mailto:')) {
          const email = url.replace('mailto:', '').split('?')[0].trim();
          if (isValidEmail(email) && !isGenericOrPlaceholderEmail(email)) return email;
        }
        if (isValidEmail(url) && !isGenericOrPlaceholderEmail(url)) return url;
      }
    }
  }

  // Check websites array
  if (Array.isArray(obj.websites)) {
    for (const site of obj.websites as Array<Record<string, unknown>>) {
      const url = site.url || site.link;
      if (typeof url === 'string' && url.startsWith('mailto:')) {
        const email = url.replace('mailto:', '').split('?')[0].trim();
        if (isValidEmail(email) && !isGenericOrPlaceholderEmail(email)) return email;
      }
    }
  }

  return undefined;
}

/** Extract phone number from BrightData result */
function extractPhone(obj: Record<string, unknown>): string | undefined {
  // Check direct fields first
  const direct = extractString(obj, [
    'phone', 'phone_number', 'mobile_phone', 'contact_phone', 'phone_numbers',
  ]);
  if (direct) return normalizePhoneNumber(direct);

  // Check bio_links for tel: links
  if (Array.isArray(obj.bio_links)) {
    for (const link of obj.bio_links as Array<Record<string, unknown>>) {
      const url = link.link || link.url;
      if (typeof url === 'string' && url.startsWith('tel:')) {
        const phone = url.replace('tel:', '').trim();
        const normalized = normalizePhoneNumber(phone);
        if (normalized) return normalized;
      }
    }
  }

  // Check websites array for tel: links
  if (Array.isArray(obj.websites)) {
    for (const site of obj.websites as Array<Record<string, unknown>>) {
      const url = site.url || site.link;
      if (typeof url === 'string' && url.startsWith('tel:')) {
        const phone = url.replace('tel:', '').trim();
        const normalized = normalizePhoneNumber(phone);
        if (normalized) return normalized;
      }
    }
  }

  return undefined;
}

/**
 * Normalize and validate phone numbers, ensuring proper format.
 * For Indian numbers: enforce 10 digits + country code.
 * Rejects incomplete numbers (7-9 digits without country code).
 */
function normalizePhoneNumber(phone: string): string | undefined {
  if (!phone) return undefined;

  // Extract only digits
  const digits = phone.replace(/\D/g, '');

  // Too short - reject (filters out incomplete 7-9 digit numbers)
  if (digits.length < 10) return undefined;

  // If exactly 10 digits and appears to be Indian (no country code), add +91
  if (digits.length === 10 && !phone.includes('+')) {
    // Check if it starts with valid Indian mobile prefix (6-9)
    if (/^[6-9]/.test(digits)) {
      return `+91${digits}`;
    }
    // Otherwise return as-is if valid length
    return phone.trim();
  }

  // If 11-12 digits and starts with 91, add + if missing
  if ((digits.length === 11 || digits.length === 12) && digits.startsWith('91')) {
    return `+${digits}`;
  }

  // If already has + and reasonable length (10-15 digits), return as-is
  if (phone.includes('+') && digits.length >= 10 && digits.length <= 15) {
    return phone.trim();
  }

  // Between 10-15 digits without clear country code - return as-is
  if (digits.length >= 10 && digits.length <= 15) {
    return phone.trim();
  }

  // Too long or doesn't match patterns - reject
  return undefined;
}

/** Extract first truthy string from candidate keys */
function extractString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

/** Extract social media URL from various possible field structures */
function extractSocialUrl(obj: Record<string, unknown>, platform: string): string | undefined {
  const directKeys = [`${platform}_url`, `${platform}Url`, platform];
  for (const key of directKeys) {
    const val = obj[key];
    if (typeof val === 'string' && val.includes(platform)) return val;
  }

  // Check nested social_links, bio_links, or similar array fields
  const arrayFields = ['social_links', 'websites', 'links', 'bio_links'];
  for (const field of arrayFields) {
    if (Array.isArray(obj[field])) {
      const link = (obj[field] as Array<Record<string, unknown>>).find(
        (l) =>
          l.platform === platform ||
          l.type === platform ||
          (typeof l.url === 'string' && l.url.includes(platform)) ||
          (typeof l.link === 'string' && (l.link as string).includes(platform))
      );
      const url = link?.url || link?.link;
      if (url && typeof url === 'string') return url;
    }
  }

  return undefined;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Generic mailboxes and placeholder addresses that should never be treated as
// a real prospect contact. Exported so other enrichment paths (Claude extraction,
// LinkedIn scrape) can apply the same guard.
const GENERIC_MAILBOX_REGEX = /^(no-?reply|info|contact|hello|support|admin|help|sales|marketing|press|media|hr|careers|jobs|team|billing|accounts|webmaster|postmaster|abuse)@/i;
const PLACEHOLDER_DOMAIN_REGEX = /@(example\.(com|org|net)|test\.|localhost|yourdomain|domain\.com)/i;
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

export function isGenericOrPlaceholderEmail(email: string): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return (
    GENERIC_MAILBOX_REGEX.test(lower) ||
    PLACEHOLDER_DOMAIN_REGEX.test(lower) ||
    IMAGE_EXTENSION_REGEX.test(lower)
  );
}

// ============================================
// EMAIL ENRICHMENT FALLBACKS
// ============================================

/**
 * Scrape company website contact/about pages to find email and phone.
 * Tries multiple common contact page paths.
 * Returns first valid email and phone found.
 */
export async function scrapeContactPageForEmail(
  websiteUrl: string
): Promise<{ email?: string; phone?: string }> {
  if (!websiteUrl) return {};

  // Normalize base URL
  let baseUrl = websiteUrl.trim();
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
  baseUrl = baseUrl.replace(/\/+$/, '');

  const contactPaths = [
    '/contact', '/contact-us', '/about', '/about-us', '/team', '/people',
    '/get-in-touch', '/connect', '/staff', '/directory', '/leadership',
    '/management', '/our-people', '/company',
  ];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
  // Regex for tel: href links
  const telHrefRegex = /href\s*=\s*["']tel:([^"']+)["']/gi;
  // Regex for WhatsApp Business links
  const waLinkRegex = /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send)\/?[^\s"'<>)]+/gi;
  // Regex for JSON-LD ContactPoint
  const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let foundEmail: string | undefined;
  let foundPhone: string | undefined;

  // First try the base URL itself
  const pagesToTry = [baseUrl, ...contactPaths.map(p => `${baseUrl}${p}`)];

  for (const pageUrl of pagesToTry) {
    if (foundEmail && foundPhone) break; // Stop once we find both

    try {
      // Prefer the scraper pool when configured — spreads source IPs
      // across the fleet, reduces chance of rate-limiting on repeated
      // probes to the same domain. Falls through to direct fetch (via
      // scrapeUrl, which uses App Runner's IP) when the pool is unset
      // or the pool call failed.
      let content: string;
      let rawContent: string;
      const pool = isScraperPoolConfigured()
        ? await scrapeViaPool(pageUrl, { kind: 'raw', timeoutMs: 8000 })
        : null;
      if (pool && pool.kind === 'raw') {
        content = pool.text;
        rawContent = pool.html;
      } else {
        const page = await scrapeUrl(pageUrl, { timeout: 8000 });
        content = page.content;
        rawContent = (page as any).html || content;
      }

      // Extract emails from content
      if (!foundEmail) {
        const emails = content.match(emailRegex) || [];
        for (const email of emails) {
          if (isValidEmail(email) && !isGenericOrPlaceholderEmail(email)) {
            foundEmail = email.toLowerCase();
            break;
          }
        }
      }

      // Extract phone numbers from content
      if (!foundPhone) {
        const phones = content.match(phoneRegex) || [];
        for (const phone of phones) {
          const normalized = normalizePhoneNumber(phone);
          if (normalized) {
            foundPhone = normalized;
            break;
          }
        }
      }

      // Extract tel: href links (more reliable than regex on text)
      if (!foundPhone) {
        let telMatch: RegExpExecArray | null;
        while ((telMatch = telHrefRegex.exec(rawContent)) !== null) {
          const phone = telMatch[1].replace(/\s+/g, '');
          const normalized = normalizePhoneNumber(phone);
          if (normalized) {
            foundPhone = normalized;
            break;
          }
        }
      }

      // Extract WhatsApp Business links for phone
      if (!foundPhone) {
        const waMatches = rawContent.match(waLinkRegex) || [];
        for (const waLink of waMatches) {
          // wa.me/911234567890 or api.whatsapp.com/send?phone=911234567890
          const phoneMatch = waLink.match(/(?:wa\.me\/|phone=)(\+?\d{7,15})/);
          if (phoneMatch) {
            const candidate = phoneMatch[1].startsWith('+') ? phoneMatch[1] : `+${phoneMatch[1]}`;
            const normalized = normalizePhoneNumber(candidate);
            if (normalized) {
              foundPhone = normalized;
              break;
            }
          }
        }
      }

      // Extract structured data (JSON-LD ContactPoint)
      if (!foundEmail || !foundPhone) {
        let jsonLdMatch: RegExpExecArray | null;
        while ((jsonLdMatch = jsonLdRegex.exec(rawContent)) !== null) {
          try {
            const ld = JSON.parse(jsonLdMatch[1]);
            const contactPoints = Array.isArray(ld) ? ld : [ld];
            for (const item of contactPoints) {
              // Check top-level and nested contactPoint
              const points = [item, ...(item.contactPoint ? (Array.isArray(item.contactPoint) ? item.contactPoint : [item.contactPoint]) : [])];
              for (const cp of points) {
                if (!foundEmail && cp.email && isValidEmail(cp.email) && !isGenericOrPlaceholderEmail(cp.email)) {
                  foundEmail = cp.email.toLowerCase();
                }
                if (!foundPhone && cp.telephone) {
                  const normalized = normalizePhoneNumber(String(cp.telephone));
                  if (normalized) {
                    foundPhone = normalized;
                  }
                }
              }
            }
          } catch {
            // Invalid JSON-LD, skip
          }
        }
      }
    } catch {
      // Scrape failed for this URL, try next
      continue;
    }
  }

  // Validate before returning
  const validated = validateContactData(foundEmail, foundPhone);
  return { email: validated.email, phone: validated.phone };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Enrich a batch of leads with BrightData Web Scraper.
 * Only scrapes leads that have a LinkedIn URL (scraper needs a URL input).
 * Returns a map from original lead index to enrichment result.
 *
 * Non-fatal: catches all errors and returns empty map on failure.
 */
export async function enrichLeadsWithBrightData(
  leads: BrightDataEnrichmentInput[]
): Promise<Map<number, BrightDataEnrichmentResult>> {
  const results = new Map<number, BrightDataEnrichmentResult>();

  if (!isBrightDataConfigured() || leads.length === 0) {
    return results;
  }

  // Only scrape leads with LinkedIn URLs
  const scrapableLeads: { originalIndex: number; url: string }[] = [];
  leads.forEach((lead, index) => {
    if (lead.linkedinUrl && lead.linkedinUrl.includes('linkedin.com')) {
      scrapableLeads.push({ originalIndex: index, url: lead.linkedinUrl });
    }
  });

  if (scrapableLeads.length === 0) {
    return results;
  }

  try {
    // Limit to 10 profiles per batch to stay within reasonable scrape limits
    const limitedLeads = scrapableLeads.slice(0, 10);
    const urls = limitedLeads.map(l => l.url);

    const rawResults = await scrapeLinkedInProfiles(urls);

    rawResults.forEach((raw, i) => {
      if (i < limitedLeads.length) {
        const mapped = mapScraperResult(raw);
        // Always store the result if we got avatar or any contact info
        if (mapped.email || mapped.phone || mapped.twitterUrl || mapped.githubUrl || mapped.facebookUrl || mapped.avatar) {
          results.set(limitedLeads[i].originalIndex, mapped);
        }
      }
    });
  } catch (error) {
    console.error('BrightData enrichment failed (non-fatal):', error);
  }

  return results;
}
