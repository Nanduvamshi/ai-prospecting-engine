import { NextRequest, NextResponse } from 'next/server';
import { billingErrorResponse, getBillingProvider, type BillingContext } from '@/server/billing';
import { requireAuth } from '@/server/auth/require-auth';
import { scrapeUrl } from '@/server/ai/web-scraper';
import { getProviderRouter } from '@/server/ai/providers';
import { searchSerpApi } from '@/server/discovery/serpapi';
import {
  enrichLeadsWithBrightData,
  isBrightDataConfigured,
  scrapeContactPageForEmail,
  isGenericOrPlaceholderEmail,
} from '@/server/discovery/brightdata';
import { generateEmailCandidates, extractDomain, guessDomainFromCompany } from '@/server/discovery/email-patterns';
import { verifyEmailSmart } from '@/server/discovery/catch-all-detector';
import { apolloPeopleMatch, isApolloConfigured } from '@/server/discovery/apollo';
import { lookupContact } from '@/server/network/lookup';
import { isContactGraphEnabled } from '@/server/network/config';
import { saveEnrichmentSources } from '@/server/prospects/store';
import { lookupPublicRoles } from '@/server/ingestion/public-role-store';
import { validateContactData } from '@/server/discovery/contact-validation';

export const dynamic = 'force-dynamic';

interface EnrichProspectInput {
  prospectId: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
}

interface EnrichResult {
  prospectId: string;
  enrichedFields: string[];
  data: Record<string, string>;
  /** Maps each populated field to the source that found it ('brightdata' | 'pattern' | 'claude-web' | 'contact-scrape' | 'apollo') */
  enrichmentSources?: Record<string, string>;
  error?: string;
}

const ENRICHABLE_FIELDS = ['email', 'phone', 'title', 'company', 'linkedinUrl', 'website', 'avatar'] as const;

function getMissingFields(prospect: EnrichProspectInput): string[] {
  return ENRICHABLE_FIELDS.filter(f => !prospect[f as keyof EnrichProspectInput]);
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth(request);
    if (error || !user) {
      return NextResponse.json(
        { success: false, error: error?.message || 'Authentication required' },
        { status: error?.status || 401 }
      );
    }

    // Enrichment spends money on scraping and verification calls, so check
    // before doing any of it. The charge lands afterwards, sized to what was
    // actually found.
    const billing = getBillingProvider();
    const billingCtx: BillingContext = {
      orgId: user.orgId,
      userId: user.sub,
      authToken: request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
    };
    const creditCheck = await billing.preCheck(billingCtx, 1);
    if (!creditCheck.ok) return billingErrorResponse(creditCheck);

    const body = await request.json();
    const prospects: EnrichProspectInput[] = body.prospects;

    if (!Array.isArray(prospects) || prospects.length === 0) {
      return NextResponse.json(
        { success: false, error: 'prospects array is required' },
        { status: 400 }
      );
    }

    if (prospects.length > 10) {
      return NextResponse.json(
        { success: false, error: 'Maximum 10 prospects per request' },
        { status: 400 }
      );
    }

    // Track enrichment per prospect
    const enriched: Record<string, Record<string, string>> = {};
    // Parallel source-attribution map: which phase populated each field
    const sources: Record<string, Record<string, string>> = {};
    prospects.forEach(p => { enriched[p.prospectId] = {}; sources[p.prospectId] = {}; });

    // Helper: set a field AND record which phase wrote it, only if still empty.
    // Also validates contact data before storing.
    const setField = (prospectId: string, field: string, value: string | undefined, source: string) => {
      if (!value) return;
      const data = enriched[prospectId];
      if (data[field]) return; // already populated by an earlier (more trusted) phase

      // Validate email/phone before storing
      if (field === 'email' || field === 'phone') {
        const prospect = prospects.find(p => p.prospectId === prospectId);
        const validated = validateContactData(
          field === 'email' ? value : data['email'],
          field === 'phone' ? value : data['phone'],
          prospect?.company || data['company']
        );

        // Only store if validation passed
        if (field === 'email' && !validated.email) {
          console.warn('[Enrich] Email failed validation:', { prospectId, value, source });
          return;
        }
        if (field === 'phone' && !validated.phone) {
          console.warn('[Enrich] Phone failed validation:', { prospectId, value, source });
          return;
        }

        // Use validated/formatted value
        value = field === 'email' ? validated.email : validated.phone;
      }

      data[field] = value!;
      sources[prospectId][field] = source;
    };

    // ─── Phase 1: LinkedIn enrichment via BrightData ───
    if (isBrightDataConfigured()) {
      const linkedInProspects = prospects.filter(p => p.linkedinUrl && getMissingFields(p).length > 0);
      if (linkedInProspects.length > 0) {
        try {
          const inputs = linkedInProspects.map(p => ({
            name: p.name,
            company: p.company,
            linkedinUrl: p.linkedinUrl,
            website: p.website,
          }));

          const results = await enrichLeadsWithBrightData(inputs);

          linkedInProspects.forEach((prospect, idx) => {
            const result = results.get(idx);
            if (!result) return;

            if (!prospect.email && result.email && !isGenericOrPlaceholderEmail(result.email)) {
              setField(prospect.prospectId, 'email', result.email, 'brightdata');
            }
            if (!prospect.phone && result.phone) setField(prospect.prospectId, 'phone', result.phone, 'brightdata');
            if (!prospect.title && result.location) setField(prospect.prospectId, 'location', result.location, 'brightdata');
            if (result.avatar) setField(prospect.prospectId, 'avatar', result.avatar, 'brightdata');
          });
        } catch (err) {
          console.error('[Enrich] BrightData phase failed (non-fatal):', err);
        }
      }
    }

    // ─── Phase 1b: Email pattern guessing + Bouncer/SMTP verification ───
    // Uses domain guessing + 15+ patterns from BW_Prospecting_hub
    const needsEmailPattern = prospects.filter(p => {
      const current = { ...p, ...enriched[p.prospectId] };
      return !current.email && p.name;
    });

    if (needsEmailPattern.length > 0) {
      const patternPromises = needsEmailPattern.slice(0, 10).map(async (prospect) => {
        // Resolve domain: from website, or guess from company name
        const website = enriched[prospect.prospectId].website || prospect.website;
        let domain = extractDomain(website || '');
        if (!domain && prospect.company) {
          try {
            domain = await guessDomainFromCompany(prospect.company);
          } catch { /* Non-fatal */ }
        }
        if (!domain) return;

        const candidates = generateEmailCandidates(prospect.name, domain);
        let bestEmail: string | null = null;
        let bestConfidence: 'high' | 'medium' | 'low' = 'low';

        for (const candidate of candidates.slice(0, 15)) {
          try {
            const result = await verifyEmailSmart(candidate.email, domain);
            if (result.verified) {
              // No `bestConfidence !== 'high'` test is needed on the medium
              // branch: the high branch always breaks, so bestConfidence can
              // never hold 'high' by the time it runs. Same pattern appears in
              // the pipeline runner.
              if (result.confidence === 'high') {
                setField(prospect.prospectId, 'email', candidate.email, 'pattern-verified');
                break; // High confidence, stop searching
              } else if (result.confidence === 'medium') {
                bestEmail = candidate.email;
                bestConfidence = 'medium';
              } else if (!bestEmail) {
                bestEmail = candidate.email;
                bestConfidence = 'low';
              }
            }
          } catch {
            // Non-fatal
          }
        }

        // Use best available if no high-confidence found
        if (!enriched[prospect.prospectId].email && bestEmail) {
          setField(prospect.prospectId, 'email', bestEmail, 'pattern-verified');
        }
      });
      await Promise.allSettled(patternPromises);
    }

    // ─── Phase 2: Web search + AI extraction for prospects still missing fields ───
    const needsWebSearch = prospects.filter(p => {
      const current = { ...p, ...enriched[p.prospectId] };
      return !current.email || !current.phone || !current.title || !current.linkedinUrl;
    });

    if (needsWebSearch.length > 0) {
      try {
        const router = getProviderRouter();

        // Build search queries per prospect (max 2 per prospect)
        const searchPromises = needsWebSearch.slice(0, 10).map(async (prospect) => {
          const current = { ...prospect, ...enriched[prospect.prospectId] };
          const queries: string[] = [];

          // Always include company name to narrow search results and avoid matching wrong people
          if (prospect.company) {
            queries.push(`"${prospect.name}" "${prospect.company}" email contact`);
            if (!current.linkedinUrl) {
              queries.push(`site:linkedin.com/in/ "${prospect.name}" "${prospect.company}"`);
            }
          } else {
            // Fallback when no company: use full name only
            if (!current.linkedinUrl) {
              queries.push(`site:linkedin.com/in/ "${prospect.name}"`);
            }
            queries.push(`"${prospect.name}" email phone contact`);
          }

          // Search and scrape
          const allContent: string[] = [];
          for (const query of queries.slice(0, 2)) {
            try {
              const results = await searchSerpApi(query, { num: 3 });
              const scrapePromises = results.slice(0, 3).map(async (r) => {
                try {
                  const scraped = await scrapeUrl(r.url, { timeout: 8000, maxPages: 1 });
                  return scraped?.content ? `URL: ${r.url}\n${scraped.content.substring(0, 2000)}` : `URL: ${r.url}\n${r.snippet}`;
                } catch {
                  return `URL: ${r.url}\n${r.snippet}`;
                }
              });
              const scraped = await Promise.allSettled(scrapePromises);
              scraped.forEach(r => { if (r.status === 'fulfilled') allContent.push(r.value); });
            } catch {
              // Non-fatal: search failed for this query
            }
          }

          if (allContent.length === 0) return null;

          // AI extraction
          const missingFields = getMissingFields({ ...prospect, ...enriched[prospect.prospectId] } as EnrichProspectInput);
          const response = await router.route({
            model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            maxTokens: 1024,
            messages: [{
              role: 'user',
              content: `Extract contact information for "${prospect.name}"${prospect.company ? ` at "${prospect.company}"` : ''} from these web pages.

I need these missing fields: ${missingFields.join(', ')}

Web content:
${allContent.join('\n\n---\n\n')}

Return ONLY this JSON (no markdown):
{
  "email": "found email or empty string",
  "phone": "found phone with country code or empty string",
  "title": "job title or empty string",
  "company": "company name or empty string",
  "linkedinUrl": "linkedin profile url or empty string",
  "website": "company website or empty string"
}

IMPORTANT RULES:
- Only include data that is clearly about "${prospect.name}", not other people on the page
- Do NOT fabricate any information
- For phone numbers: Look in contact sections, footers, tel: links, WhatsApp links (wa.me/), and any visible formats
- For Indian phone numbers: Extract full 10 digits with +91 country code (e.g., +919876543210)
- For email: Check contact sections, team pages, author bylines, mailto: links - extract ANY email associated with this person
- Filter out generic emails (noreply@, info@, support@, admin@, contact@)
- Be VERY thorough in extracting contact information - check every section of each page`,
            }],
          });

          const text = response.content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
          if (!text) return null;

          const jsonMatch = text.text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return null;

          const extracted = JSON.parse(jsonMatch[0]);
          return { prospectId: prospect.prospectId, prospect, extracted };
        });

        const searchResults = await Promise.allSettled(searchPromises);
        searchResults.forEach(r => {
          if (r.status !== 'fulfilled' || !r.value) return;
          const { prospectId, prospect, extracted } = r.value;

          if (!prospect.email && extracted.email && !isGenericOrPlaceholderEmail(extracted.email)) {
            setField(prospectId, 'email', extracted.email, 'claude-web');
          }
          if (!prospect.phone && extracted.phone) setField(prospectId, 'phone', extracted.phone, 'claude-web');
          if (!prospect.title && extracted.title) setField(prospectId, 'title', extracted.title, 'claude-web');
          if (!prospect.company && extracted.company) setField(prospectId, 'company', extracted.company, 'claude-web');
          if (!prospect.linkedinUrl && extracted.linkedinUrl) setField(prospectId, 'linkedinUrl', extracted.linkedinUrl, 'claude-web');
          if (!prospect.website && extracted.website) setField(prospectId, 'website', extracted.website, 'claude-web');
        });
      } catch (err) {
        console.error('[Enrich] Web search phase failed (non-fatal):', err);
      }
    }

    // ─── Phase 3: Contact page scraping fallback ───
    const needsEmail = prospects.filter(p => {
      const current = { ...p, ...enriched[p.prospectId] };
      return !current.email && (current.website || p.website);
    });

    if (needsEmail.length > 0) {
      const fallbackPromises = needsEmail.slice(0, 10).map(async (prospect) => {
        const website = enriched[prospect.prospectId].website || prospect.website;
        if (!website) return;
        try {
          const result = await scrapeContactPageForEmail(website);
          if (result.email && !prospect.email && !isGenericOrPlaceholderEmail(result.email)) {
            setField(prospect.prospectId, 'email', result.email, 'contact-scrape');
          }
          if (result.phone && !prospect.phone) setField(prospect.prospectId, 'phone', result.phone, 'contact-scrape');
        } catch {
          // Non-fatal
        }
      });
      await Promise.allSettled(fallbackPromises);
    }

    // ─── Phase 3.5: Internal contact-graph lookup (before paid Apollo fallback) ───
    // If the graph has a record for this prospect (and caller's org is an opted-in
    // contributor), use it — cheaper than Apollo + more likely to be accurate for
    // contacts that existing users have actually interacted with.
    if (isContactGraphEnabled()) {
      const needsGraph = prospects.filter(p => {
        const current = { ...p, ...enriched[p.prospectId] };
        // Graph is email-indexed (sha256 hash); need a candidate email to lookup.
        return (!current.phone || !current.title || !current.linkedinUrl) && current.email;
      });
      if (needsGraph.length > 0) {
        await Promise.allSettled(needsGraph.slice(0, 10).map(async (prospect) => {
          const candidateEmail = enriched[prospect.prospectId].email || prospect.email;
          if (!candidateEmail) return;
          try {
            const result = await lookupContact({ email: candidateEmail, callerOrgId: user.orgId });
            if (!result.found || !result.contact) return;
            const c = result.contact;
            if (c.phone && !prospect.phone) setField(prospect.prospectId, 'phone', c.phone, 'contact-graph');
            if (c.title && !prospect.title) setField(prospect.prospectId, 'title', c.title, 'contact-graph');
            if (c.linkedinUrl && !prospect.linkedinUrl) setField(prospect.prospectId, 'linkedinUrl', c.linkedinUrl, 'contact-graph');
            if (c.company && !prospect.company) setField(prospect.prospectId, 'company', c.company, 'contact-graph');
          } catch {
            // Non-fatal — just skip graph for this prospect
          }
        }));
      }
    }

    // ─── Phase 3.75: Public-role registry (Track C Phase C2) ───
    // When we have a company + target title but no email, consult the
    // public-role registry populated by the data-ingestion adapters
    // (SEC officers today; Crunchbase / job-postings later). If a name
    // matches the prospect's target title at that company, generate
    // email candidates from that name and run them through the verifier.
    // Cheaper than Apollo and a real usage signal for the SEC data.
    const publicRoleCandidates = prospects.filter(p => {
      const current = { ...p, ...enriched[p.prospectId] };
      return !current.email && p.company && p.title;
    });
    if (publicRoleCandidates.length > 0) {
      await Promise.allSettled(publicRoleCandidates.slice(0, 10).map(async (prospect) => {
        try {
          // Match on the first word of the title so "VP Engineering"
          // matches "VP Eng", "Vice President Engineering", etc.
          const titlePrefix = (prospect.title || '').split(/\s+/)[0];
          const roles = await lookupPublicRoles(prospect.company!, {
            titlePrefix,
            limit: 5,
          });
          if (roles.length === 0) return;

          const websiteHint = enriched[prospect.prospectId].website || prospect.website;
          const resolvedDomain = websiteHint
            ? (extractDomain(websiteHint) || websiteHint)
            : await guessDomainFromCompany(prospect.company!);
          if (!resolvedDomain) return;
          const normalizedDomain = resolvedDomain;

          // Try candidates from each matched public role until one verifies.
          for (const role of roles) {
            if (!role.name) continue;
            const candidates = generateEmailCandidates(role.name, normalizedDomain);
            let verified: string | null = null;
            for (const candidate of candidates.slice(0, 8)) {
              try {
                const result = await verifyEmailSmart(candidate.email, normalizedDomain);
                if (result.verified && result.confidence === 'high') {
                  verified = candidate.email;
                  break; // High confidence, stop
                } else if (result.verified && !verified) {
                  verified = candidate.email; // Keep medium/low as backup
                }
              } catch { /* non-fatal */ }
            }
            if (verified) {
              setField(prospect.prospectId, 'email', verified, 'public-role');
              // The public-role entry also carries title — if prospect
              // didn't have one (or had a stale one), record the
              // source for transparency.
              if (!prospect.title && role.title) {
                setField(prospect.prospectId, 'title', role.title, 'public-role');
              }
              break;
            }
          }
        } catch {
          // Non-fatal — skip this prospect if the registry lookup fails
        }
      }));
    }

    // ─── Phase 4: Apollo People Match fallback ───
    // Last-resort for prospects where pattern+Bouncer and web scraping both failed.
    // Apollo returns pre-verified emails from its 275M-contact DB.
    if (isApolloConfigured()) {
      const needsApollo = prospects.filter(p => {
        const current = { ...p, ...enriched[p.prospectId] };
        return !current.email && p.name && p.company;
      });

      if (needsApollo.length > 0) {
        const apolloPromises = needsApollo.slice(0, 10).map(async (prospect) => {
          try {
            const match = await apolloPeopleMatch(prospect.name, prospect.company!);
            if (!match) return;
            if (match.email && !prospect.email && !isGenericOrPlaceholderEmail(match.email)) {
              setField(prospect.prospectId, 'email', match.email, 'apollo');
            }
            if (match.phone && !prospect.phone) setField(prospect.prospectId, 'phone', match.phone, 'apollo');
            if (match.title && !prospect.title) setField(prospect.prospectId, 'title', match.title, 'apollo');
            if (match.linkedinUrl && !prospect.linkedinUrl) setField(prospect.prospectId, 'linkedinUrl', match.linkedinUrl, 'apollo');
          } catch {
            // Non-fatal
          }
        });
        await Promise.allSettled(apolloPromises);
      }
    }

    // ─── Build results ───
    const results: EnrichResult[] = prospects.map(p => {
      const data = enriched[p.prospectId];
      const enrichedFields = Object.keys(data).filter(k => data[k]);
      const src = sources[p.prospectId];
      // Only include sources for fields actually populated
      const enrichmentSources: Record<string, string> = {};
      for (const f of enrichedFields) if (src[f]) enrichmentSources[f] = src[f];
      return {
        prospectId: p.prospectId,
        enrichedFields,
        data,
        enrichmentSources: Object.keys(enrichmentSources).length > 0 ? enrichmentSources : undefined,
      };
    });

    // Charge 1 credit per prospect that got new contact info (email/phone)
    const enrichedWithContact = results.filter(r =>
      r.enrichedFields.includes('email') || r.enrichedFields.includes('phone')
    ).length;
    const enrichedWithoutContact = results.filter(r =>
      r.enrichedFields.length > 0 &&
      !r.enrichedFields.includes('email') &&
      !r.enrichedFields.includes('phone')
    ).length;
    const totalCost = (enrichedWithContact * 2) + (enrichedWithoutContact * 1);
    const actualCost = Math.min(totalCost, creditCheck.balance);

    if (actualCost > 0) {
      const enrichedCount = enrichedWithContact + enrichedWithoutContact;
      await billing.consume(
        billingCtx,
        'lead_generation',
        actualCost,
        {
          description: `Find Leads — enriched ${enrichedCount} prospect${enrichedCount === 1 ? '' : 's'}${enrichedWithContact > 0 ? ` (${enrichedWithContact} with contact info)` : ''}`,
          context: {
            surface: 'crm.prospects.enrich',
            resultCount: enrichedCount,
            withContact: enrichedWithContact,
            withoutContact: enrichedWithoutContact,
            prospectsRequested: results.length,
          },
        }
      );
    }

    // Persist enrichment provenance to a sister record so badges survive
    // reload. Fire-and-forget — badge loss on failure is not worth blocking.
    for (const r of results) {
      if (r.enrichmentSources && Object.keys(r.enrichmentSources).length > 0) {
        saveEnrichmentSources(user.orgId, r.prospectId, r.enrichmentSources)
          .catch(err => console.warn('[Enrich] sister-record write failed:', err instanceof Error ? err.message : String(err)));
      }
    }

    const totalEnriched = results.filter(r => r.enrichedFields.length > 0).length;

    return NextResponse.json({
      success: true,
      results,
      totalEnriched,
      creditCost: actualCost,
    });

  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const errMeta = (err as { $metadata?: unknown })?.$metadata;
    console.error('[Enrich] Error:', {
      errName,
      errMsg: err instanceof Error ? err.message : String(err),
      errMeta,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { success: false, error: 'Enrichment failed' },
      { status: 500 }
    );
  }
}
