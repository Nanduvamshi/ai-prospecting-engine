import { NextRequest, NextResponse } from 'next/server';
import { BRIGHTDATA_CONFIG } from '@/server/discovery/config';

/**
 * POST /api/crm/prospects/enrich-linkedin
 * Enriches LinkedIn profile URLs using BrightData's LinkedIn People scraper.
 * Returns real profile data: name, title, company, avatar, email, etc.
 *
 * Body: { urls: string[] }  (max 10)
 * Returns: { profiles: EnrichedProfile[] }
 */

interface EnrichedProfile {
  linkedinUrl: string;
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  location?: string;
  about?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const urls: string[] = body.urls || [];

    if (!urls.length) {
      return NextResponse.json({ error: 'No URLs provided' }, { status: 400 });
    }

    // Cap at 10 profiles per request
    const limitedUrls = urls.slice(0, 10);

    // Check if BrightData is configured
    if (!BRIGHTDATA_CONFIG.IS_CONFIGURED || !BRIGHTDATA_CONFIG.API_TOKEN) {
      // Fallback: return stub data from URL slugs
      const profiles = limitedUrls.map(url => profileFromUrlSlug(url));
      return NextResponse.json({ profiles, enriched: false });
    }

    // Call BrightData LinkedIn People scraper
    const input = limitedUrls.map(url => ({ url }));

    const response = await fetch(
      `${BRIGHTDATA_CONFIG.API_URL}/scrape?dataset_id=${BRIGHTDATA_CONFIG.SCRAPER_ID}&format=json&include_errors=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_CONFIG.API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      }
    );

    let rawResults: Record<string, unknown>[] = [];

    if (response.status === 200) {
      rawResults = await response.json();
    } else if (response.status === 202) {
      // Async — poll for results
      const data = await response.json();
      const snapshotId = data.snapshot_id;
      if (snapshotId) {
        rawResults = await pollSnapshot(snapshotId);
      }
    } else {
      console.error('BrightData scrape failed:', response.status, await response.text().catch(() => ''));
    }

    // Map raw results to enriched profiles
    const profiles: EnrichedProfile[] = limitedUrls.map((url, i) => {
      const raw = rawResults[i];
      if (!raw) return profileFromUrlSlug(url);

      const name = getString(raw, ['name', 'full_name', 'fullName']) || nameFromSlug(url);
      const title = getString(raw, ['title', 'headline', 'job_title', 'current_company_position']);
      const company = getString(raw, ['company', 'current_company', 'current_company_name', 'organization']);
      const email = extractEmail(raw);
      const phone = getString(raw, ['phone', 'phone_number', 'mobile_phone']);
      const avatar = extractAvatar(raw);
      const location = getString(raw, ['city', 'location', 'country']);
      const about = getString(raw, ['about', 'summary', 'bio', 'description']);

      return {
        linkedinUrl: url,
        name: name || 'LinkedIn Contact',
        title: title || undefined,
        company: company || undefined,
        email: email || undefined,
        phone: phone || undefined,
        avatar: avatar || undefined,
        location: location || undefined,
        about: about ? about.slice(0, 200) : undefined,
      };
    });

    return NextResponse.json({ profiles, enriched: true });
  } catch (error) {
    console.error('LinkedIn enrichment error:', error);
    return NextResponse.json({ error: 'Enrichment failed' }, { status: 500 });
  }
}

// --- Helpers ---

async function pollSnapshot(snapshotId: string, maxWaitMs = 45000): Promise<Record<string, unknown>[]> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const res = await fetch(
      `${BRIGHTDATA_CONFIG.API_URL}/snapshot/${snapshotId}?format=json`,
      { headers: { 'Authorization': `Bearer ${BRIGHTDATA_CONFIG.API_TOKEN}` } }
    );
    if (res.status === 200) return res.json();
    if (res.status !== 202) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  return [];
}

function getString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

function extractEmail(obj: Record<string, unknown>): string | undefined {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const direct = getString(obj, ['email', 'work_email', 'personal_email', 'contact_email']);
  if (direct && emailRegex.test(direct)) return direct;

  // Check bio_links array
  if (Array.isArray(obj.bio_links)) {
    for (const link of obj.bio_links as Array<Record<string, unknown>>) {
      const url = (link.link || link.url) as string | undefined;
      if (typeof url === 'string' && url.startsWith('mailto:')) {
        const email = url.replace('mailto:', '').split('?')[0].trim();
        if (emailRegex.test(email)) return email;
      }
    }
  }
  return undefined;
}

function extractAvatar(obj: Record<string, unknown>): string | undefined {
  const avatar = obj.avatar;
  if (typeof avatar === 'string' && avatar.startsWith('http') && !obj.default_avatar) return avatar;
  return getString(obj, ['profile_pic', 'profile_image', 'profile_photo', 'image_url']);
}

function nameFromSlug(url: string): string {
  const match = url.match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/);
  if (!match) return 'LinkedIn Contact';
  const slug = match[1].replace(/-[0-9a-f]{6,}$/, '');
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function profileFromUrlSlug(url: string): EnrichedProfile {
  return { linkedinUrl: url, name: nameFromSlug(url) };
}
