// ============================================
// FIND-LEADS BACKGROUND RUNNER
// Executes the prospecting pipeline off the request path and updates a
// FindLeadsJob record in Postgres after each phase. The POST route fires
// this via an unawaited promise so the HTTP response returns in <1s.
//
// Phase layout (mirrors the phaseLabel table in the plan):
//   1. Understanding your request…
//   2. Searching across the web…
//   3. Reading the most relevant pages…
//   4. Identifying promising leads…
//   5. Checking Crunchbase, GitHub and Apollo…
//   6. Enriching profiles and avatars…
//   7. Finding verified email addresses…
//   8. Finalising your list…
// ============================================

import { getBillingProvider, type BillingContext } from '@/server/billing';
import {
  calculateTotalLeadsCost,
  truncateLeadsToBudget,
} from '@/server/billing/lead-credit-cost';
import { scrapeUrl } from '@/server/ai/web-scraper';
import { getProviderRouter } from '@/server/ai/providers';
import {
  searchSerpApi,
  buildFilterQueries,
  buildAiModeSystemPrompt,
  type LeadSearchQuery,
} from '@/server/discovery/serpapi';
import {
  enrichLeadsWithBrightData,
  isBrightDataConfigured,
  scrapeContactPageForEmail,
} from '@/server/discovery/brightdata';
import { getSearchConfig, type SearchDepth } from '@/server/discovery/search-config';
import {
  generateEmailCandidates,
  extractDomain,
  guessDomainFromCompany,
} from '@/server/discovery/email-patterns';
import {
  createSearchBudget,
  domainFor,
  resetDomainRunCache,
  resolveCompanyDomains,
} from '@/server/discovery/company-domain';
import { firstRegion, type RegionCode } from '@/server/discovery/region';
import { getOrgICP } from '@/server/icp/store';
import { verifyEmailSmart } from '@/server/discovery/catch-all-detector';
import { getIntentSignals } from '@/server/discovery/intent-signals';
import { enrichCompanies } from '@/server/discovery/company-enrichment';
import { searchCrunchbase } from '@/server/discovery/crunchbase';
import { searchGitHub } from '@/server/discovery/github';
import { searchApollo, isApolloConfigured } from '@/server/discovery/apollo';
import { validateContactData } from '@/server/discovery/contact-validation';

import {
  getFindLeadsJobInternal,
  markJobCompleted,
  markJobFailed,
  setPartialLeads,
  updateFindLeadsJobPhase,
  type FindLeadsErrorCode,
  type FindLeadsJobRequest,
  type PartialLead,
} from './jobs';

type LeadSource = 'google' | 'crunchbase' | 'github' | 'apollo';

export interface RunnerParams {
  jobId: string;
  orgId: string;
  /** Needed to identify the spender to the billing provider. */
  userId: string;
  authToken: string;
  creditBalance: number;
  request: FindLeadsJobRequest;
  /** Parent transaction id when this run was triggered by a Copilot chat
   * turn's tool use. Passed through to the consume call so the credit log
   * can group this charge under the Copilot row. */
  parentTransactionId?: string;
}

/** Maps a caught error to a user-safe code + message.
 *
 * Order matters: the tagged `SearchProviderError` check runs before any
 * substring fuzzy-match so we don't mis-classify an upstream search
 * failure as a "lots of searches" rate limit (that ambiguity was
 * the bug Hardik hit — SerpAPI quota surfaced as "we're getting a lot
 * of searches"). `rate_limited` is now reserved for the rare case
 * where the *downstream* classifier genuinely can't tell which
 * provider throttled (kept as a catch-all, not a default). */
function classifyError(err: unknown): {
  code: FindLeadsErrorCode;
  message: string;
} {
  const name = err instanceof Error ? err.name : '';
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // Precise tag from ddg-search.ts / serpapi.ts fallback paths.
  if (name === 'SearchProviderError') {
    return {
      code: 'search_unavailable',
      message:
        "Our search service is temporarily unavailable. We're on it — please try again in a minute.",
    };
  }

  if (
    lower.includes('bedrock') ||
    lower.includes('anthropic') ||
    lower.includes('claude') ||
    lower.includes('modelstream') ||
    lower.includes('no response from ai')
  ) {
    return {
      code: 'ai_unavailable',
      message: "We couldn't reach the AI right now. Please try again in a minute.",
    };
  }
  if (lower.includes('no search results') || lower.includes('no leads')) {
    return {
      code: 'no_results',
      message: 'We couldn\'t find matching leads. Try a broader description or different sources.',
    };
  }
  // Last-resort fuzzy match for throttling signals we couldn't tag
  // precisely (e.g. an upstream library wrapping the error).
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('throttl')) {
    return {
      code: 'rate_limited',
      message:
        "Our search service is temporarily unavailable. We're on it — please try again in a minute.",
    };
  }
  return {
    code: 'internal',
    message: "Something went wrong on our side. Your credits weren't charged — please try again.",
  };
}

/** Abort the pipeline early if the client has cancelled the job. Called
 * between phases so we don't burn SerpAPI/Bedrock calls after the user
 * closed the modal. */
async function isCancelled(orgId: string, jobId: string): Promise<boolean> {
  const job = await getFindLeadsJobInternal(orgId, jobId);
  return job?.status === 'cancelled';
}

/**
 * Country for this run, or null.
 *
 * Nothing downstream used to know where a search was aimed, so results drifted
 * (a Bondi search returned venues in Falmouth and New York) and domain guessing
 * only ever tried US-shaped TLDs.
 */
async function resolveRegionHint(
  orgId: string,
  locationHint: string | null,
): Promise<RegionCode | null> {
  const fromRequest = firstRegion(locationHint);
  if (fromRequest) return fromRequest;
  try {
    const icp = await getOrgICP(orgId);
    return firstRegion(icp?.geographies);
  } catch {
    return null;
  }
}

export async function runFindLeadsJob(params: RunnerParams): Promise<void> {
  const { jobId, orgId, userId, authToken, creditBalance, request: body, parentTransactionId } = params;
  const billingCtx: BillingContext = { orgId, userId, authToken };

  // Where this search is looking, used to bias web search and to pick the
  // right country TLDs when resolving a company domain. Filters mode states it
  // outright; AI mode only implies it in the prompt, so the org's saved ICP
  // supplies it there. Null means no bias, which beats a wrong one.
  const locationHint = body.locations?.trim() || null;
  const regionHint = await resolveRegionHint(orgId, locationHint);
  const router = getProviderRouter();
  const searchConfig = getSearchConfig(body.searchDepth);

  // Log configuration status for debugging
  console.log('[find-leads-runner] Configuration status:', {
    brightDataConfigured: isBrightDataConfigured(),
    apolloConfigured: isApolloConfigured(),
    scraperPoolConfigured: (await import('@/server/discovery/scraper-pool-client')).isScraperPoolConfigured(),
    searchDepth: body.searchDepth,
    sources: body.sources || ['google'],
  });

  try {
    // -----------------------------------------------------------
    // Phase 1 — Understanding your request
    // -----------------------------------------------------------
    await updateFindLeadsJobPhase(orgId, jobId, {
      status: 'running',
      phase: 1,
      phaseLabel: 'Understanding your request…',
      percentComplete: 5,
    });

    let searchQueries: LeadSearchQuery[] = [];
    if (body.mode === 'filters') {
      const jobTitles = body.jobTitles?.split(',').map(t => t.trim()).filter(Boolean) || [];
      const industries = body.industries || [];
      const locations = body.locations?.split(',').map(l => l.trim()).filter(Boolean) || [];
      if (jobTitles.length === 0 && industries.length === 0 && locations.length === 0) {
        await markJobFailed(orgId, jobId, 'internal', 'At least one filter is required.');
        return;
      }
      searchQueries = buildFilterQueries({ jobTitles, industries, locations });
    } else {
      if (!body.prompt?.trim()) {
        await markJobFailed(orgId, jobId, 'internal', 'A prompt is required for AI mode.');
        return;
      }
      const queryGen = await router.route({
        model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        maxTokens: 1024,
        system: buildAiModeSystemPrompt(),
        messages: [{ role: 'user', content: body.prompt.trim() }],
      });
      const textBlock = queryGen.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No response from AI query generation');
      }
      const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('Could not parse AI-generated search queries');
      searchQueries = JSON.parse(jsonMatch[0]);
    }
    if (await isCancelled(orgId, jobId)) return;

    // -----------------------------------------------------------
    // Phase 2 — Searching across the web (SerpAPI)
    // -----------------------------------------------------------
    const limitedQueries = searchQueries.slice(0, searchConfig.maxQueries);
    await updateFindLeadsJobPhase(orgId, jobId, {
      phase: 2,
      phaseLabel: 'Searching across the web…',
      percentComplete: 15,
      searchesRun: limitedQueries.map(q => q.query),
    });

    const serpApiStart = (body.offset || 0) * searchConfig.resultsPerQuery;
    const allSearchResults: Array<{ title: string; url: string; snippet: string; queryType: string }> = [];
    // Tracks whether every rejected query failed because the search
    // provider was unavailable (vs. no results). Used below to pick
    // the right FindLeadsErrorCode — tagged SearchProviderError from
    // ddg-search / serpapi.ts is the precise signal.
    let searchProviderUnavailable = false;
    const BATCH_SIZE = 3;
    for (let i = 0; i < limitedQueries.length; i += BATCH_SIZE) {
      if (searchProviderUnavailable && allSearchResults.length > 0) break;
      const batch = limitedQueries.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(sq =>
          searchSerpApi(sq.query, { num: searchConfig.resultsPerQuery, start: serpApiStart })
            .then(results => results.map(r => ({ ...r, queryType: sq.type })))
        )
      );
      for (const result of batchResults) {
        if (result.status === 'fulfilled') allSearchResults.push(...result.value);
        else {
          const reasonName =
            result.reason instanceof Error ? result.reason.name : '';
          if (reasonName === 'SearchProviderError') {
            searchProviderUnavailable = true;
          }
        }
      }
    }
    if (allSearchResults.length === 0 && searchProviderUnavailable && searchConfig !== getSearchConfig('quick')) {
      const quickConfig = getSearchConfig('quick');
      const fallbackQueries = searchQueries.slice(0, quickConfig.maxQueries);
      const fallbackResults = await Promise.allSettled(
        fallbackQueries.map(sq =>
          searchSerpApi(sq.query, { num: quickConfig.resultsPerQuery, start: serpApiStart })
            .then(results => results.map(r => ({ ...r, queryType: sq.type })))
        )
      );
      for (const r of fallbackResults) {
        if (r.status === 'fulfilled') allSearchResults.push(...r.value);
      }
    }
    if (allSearchResults.length === 0) {
      await markJobFailed(
        orgId,
        jobId,
        searchProviderUnavailable ? 'search_unavailable' : 'no_results',
        searchProviderUnavailable
          ? "Our search service is temporarily unavailable. We're on it — please try again in a minute."
          : "We couldn't find matching leads. Try a broader description or different sources.",
      );
      return;
    }
    const uniqueResults = Array.from(new Map(allSearchResults.map(r => [r.url, r])).values());
    if (await isCancelled(orgId, jobId)) return;

    // -----------------------------------------------------------
    // Phase 3 — Reading the most relevant pages (web scrape)
    // -----------------------------------------------------------
    await updateFindLeadsJobPhase(orgId, jobId, {
      phase: 3,
      phaseLabel: 'Reading the most relevant pages…',
      percentComplete: 30,
    });
    const scrapableResults = uniqueResults.slice(0, searchConfig.maxPagesScraped);
    const scrapeResults = await Promise.allSettled(
      scrapableResults.map(async (result) => {
        try {
          const page = await scrapeUrl(result.url, { timeout: 10000 });
          const truncatedContent = page.content.length > searchConfig.contentTruncateLength
            ? page.content.slice(0, searchConfig.contentTruncateLength) + '...'
            : page.content;
          return { url: result.url, title: page.title || result.title, content: truncatedContent, queryType: result.queryType };
        } catch {
          return { url: result.url, title: result.title, content: result.snippet, queryType: result.queryType };
        }
      })
    );
    const scrapedContents: Array<{ url: string; title: string; content: string; queryType: string }> = [];
    scrapeResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value) scrapedContents.push(r.value);
    });
    if (scrapedContents.length === 0) {
      await markJobFailed(orgId, jobId, 'no_results', 'Could not extract content from search results.');
      return;
    }
    if (await isCancelled(orgId, jobId)) return;

    // -----------------------------------------------------------
    // Phase 4 — Identifying promising leads (Claude extraction)
    // -----------------------------------------------------------
    await updateFindLeadsJobPhase(orgId, jobId, {
      phase: 4,
      phaseLabel: 'Identifying promising leads…',
      percentComplete: 50,
    });
    const combinedContent = scrapedContents
      .map((s, i) => `--- PAGE ${i + 1} ---\nURL: ${s.url}\nTitle: ${s.title}\nType: ${s.queryType}\n${s.content}`)
      .join('\n\n');
    const searchContext = body.mode === 'filters'
      ? `Job Titles: ${body.jobTitles || 'any'}\nIndustries: ${body.industries?.join(', ') || 'any'}\nLocations: ${body.locations || 'any'}`
      : `User Prompt: ${body.prompt}`;

    const extractionResponse = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 8192,
      system: `You are an expert B2B lead extraction specialist. You analyze web page content (from LinkedIn profiles, company team pages, about pages, contact pages, etc.) and extract structured lead information. Always respond with valid JSON only. Be conservative with names and titles - only extract where clearly identified. Be VERY AGGRESSIVE with contact information - thoroughly scan every page for:
- Email addresses: Check contact sections, team bios, footer links, mailto: attributes, structured data, author bylines, profile cards, and ANY visible email format
- Phone numbers: Look thoroughly in page footers, contact sections, "call us" text, tel: links, structured data, vCard data, sidebar widgets, WhatsApp links (wa.me/), and any visible phone formats (+1-555-123-4567, (555) 123-4567, etc.). For Indian numbers, include full 10 digits with +91 country code when visible
- Social profiles: LinkedIn URLs, Twitter handles, GitHub profiles, Facebook pages
Do not fabricate information, but DO extract every piece of contact info you can find on the pages.`,
      messages: [{
        role: 'user',
        content: `Extract B2B leads from the following scraped web pages. Search context:
${searchContext}

Scraped Content:
${combinedContent}

For each person identified, extract:
- name, title, company, companyDomain, linkedinUrl, website, email, phone, twitterUrl, githubUrl, facebookUrl, location, seniority (one of: C-level, VP, Director, Manager, Senior IC, IC, Unknown), department (one of: Engineering, Sales, Marketing, Product, Finance, HR, Operations, Other), score (0-100), confidence (high/medium/low).

Return ONLY this JSON structure:
{
  "leads": [{ "name": "...", "title": "...", "company": "...", "companyDomain": "...", "linkedinUrl": "...", "website": "...", "email": "", "phone": "", "twitterUrl": "", "githubUrl": "", "facebookUrl": "", "location": "", "seniority": "IC", "department": "Other", "score": 50, "confidence": "medium" }],
  "summary": "Brief 1-sentence summary of what was found"
}

IMPORTANT:
- Only include real people with identifiable names
- Extract ALL contact info visible on each page (especially email and phone)
- For phone numbers, prefer format with country code (e.g., +91XXXXXXXXXX for India)
- Filter out generic emails (info@, support@, noreply@)
- Score higher for decision-makers matching the search criteria
- Return up to ${searchConfig.maxLeads} leads max, sorted by score descending
- Empty leads array if nothing found`,
      }],
    });

    const extractionText = extractionResponse.content.find(b => b.type === 'text');
    if (!extractionText || extractionText.type !== 'text') {
      throw new Error('No response from AI extraction');
    }
    const extractionJsonMatch = extractionText.text.match(/\{[\s\S]*\}/);
    if (!extractionJsonMatch) throw new Error('Could not parse AI extraction response');
    const extractionResult = JSON.parse(extractionJsonMatch[0]);

    const excludeNameSet = new Set((body.excludeNames || []).map(n => n.toLowerCase()));
    const excludeUrlSet = new Set((body.excludeUrls || []).map(u => u.toLowerCase()));
    const allLeads: PartialLead[] = (extractionResult.leads || []).map((l: Record<string, unknown>) => {
      // Validate contact data before storing
      const validated = validateContactData(
        (l.email as string) || '',
        (l.phone as string) || '',
        (l.companyDomain as string) || ''
      );

      // Log validation issues for debugging (but don't block the lead)
      if (validated.validationIssues && validated.validationIssues.length > 0) {
        console.warn('[find-leads-runner] Contact validation issues:', {
          name: l.name,
          issues: validated.validationIssues,
        });
      }

      return {
        name: (l.name as string) || 'Unknown',
        title: (l.title as string) || 'Unknown',
        company: (l.company as string) || '',
        companyDomain: (l.companyDomain as string) || '',
        linkedinUrl: (l.linkedinUrl as string) || undefined,
        website: (l.website as string) || undefined,
        email: validated.email || '', // Use validated email
        phone: validated.phone || '', // Use validated phone
        twitterUrl: (l.twitterUrl as string) || '',
        githubUrl: (l.githubUrl as string) || '',
        facebookUrl: (l.facebookUrl as string) || '',
        avatar: '',
        location: (l.location as string) || '',
        seniority: (l.seniority as string) || 'Unknown',
        department: (l.department as string) || 'Other',
        score: typeof l.score === 'number' ? Math.min(100, Math.max(0, l.score as number)) : 50,
        confidence: (l.confidence as string) || 'medium',
        source: (l.linkedinUrl as string) || (l.website as string) || '',
      };
    });

    let leads = allLeads.filter(l =>
      !excludeNameSet.has(l.name.toLowerCase()) &&
      !(l.linkedinUrl && excludeUrlSet.has(l.linkedinUrl.toLowerCase()))
    );

    // First partial-leads write — the UI will now render lead cards even
    // before enrichment completes. Cards get email/avatar filled in later.
    await setPartialLeads(orgId, jobId, leads);
    if (await isCancelled(orgId, jobId)) return;

    // -----------------------------------------------------------
    // Phase 5 — Checking Crunchbase, GitHub and Apollo
    // -----------------------------------------------------------
    const sources = (body.sources as LeadSource[] | undefined) || ['google'];
    if (sources.some(s => s !== 'google')) {
      await updateFindLeadsJobPhase(orgId, jobId, {
        phase: 5,
        phaseLabel: 'Checking Crunchbase, GitHub and Apollo…',
        percentComplete: 60,
      });
      const multiSourceQuery = body.mode === 'filters'
        ? `${body.jobTitles || ''} ${body.industries?.join(' ') || ''} ${body.locations || ''}`.trim()
        : body.prompt || '';
      const additionalSourcePromises: Promise<PartialLead[]>[] = [];

      if (sources.includes('crunchbase')) {
        additionalSourcePromises.push(
          searchCrunchbase(multiSourceQuery, { maxResults: 10 })
            .then(results => results.map(r => ({
              name: r.name, title: r.title || '', company: r.company || '',
              companyDomain: '', linkedinUrl: r.linkedinUrl, website: r.website,
              email: '', phone: '', twitterUrl: '', githubUrl: '', facebookUrl: '',
              avatar: '', location: r.location || '', seniority: 'Unknown', department: 'Other',
              score: r.score, confidence: 'medium', source: r.source,
              companyEnrichment: r.companyData ? {
                funding: r.companyData.funding, fundingAmount: r.companyData.fundingAmount,
                industry: r.companyData.industry, size: r.companyData.size,
                foundedYear: r.companyData.foundedYear,
              } : undefined,
            })))
            .catch(() => [])
        );
      }
      if (sources.includes('github')) {
        const locationParts = body.locations?.split(',').map(l => l.trim()).filter(Boolean) || [];
        additionalSourcePromises.push(
          searchGitHub(multiSourceQuery, { maxResults: 10, location: locationParts[0] })
            .then(results => results.map(r => ({
              name: r.name, title: r.title || 'Software Developer', company: r.company || '',
              companyDomain: '', linkedinUrl: undefined, website: r.website,
              email: r.email || '', phone: '', twitterUrl: '', githubUrl: r.githubUrl, facebookUrl: '',
              avatar: '', location: r.location || '', seniority: 'Unknown', department: 'Engineering',
              score: r.score, confidence: 'medium', source: r.source,
            })))
            .catch(() => [])
        );
      }
      if (sources.includes('apollo') && isApolloConfigured()) {
        const jobTitlesList = body.jobTitles?.split(',').map(t => t.trim()).filter(Boolean) || [];
        const locationsList = body.locations?.split(',').map(l => l.trim()).filter(Boolean) || [];
        additionalSourcePromises.push(
          searchApollo({
            jobTitles: jobTitlesList.length > 0 ? jobTitlesList : undefined,
            industries: body.industries,
            locations: locationsList.length > 0 ? locationsList : undefined,
            maxResults: 15,
          })
            .then(results => results.map(r => ({
              name: r.name, title: r.title || '', company: r.company || '',
              companyDomain: r.companyDomain || '', linkedinUrl: r.linkedinUrl, website: r.website,
              email: r.email || '', phone: r.phone || '', twitterUrl: '', githubUrl: '', facebookUrl: '',
              avatar: '', location: r.location || '', seniority: r.seniority || 'Unknown',
              department: r.department || 'Other', score: r.score, confidence: 'high',
              source: r.source,
            })))
            .catch(() => [])
        );
      }

      if (additionalSourcePromises.length > 0) {
        const additionalResults = await Promise.allSettled(additionalSourcePromises);
        for (const result of additionalResults) {
          if (result.status === 'fulfilled' && result.value.length > 0) {
            const existingNames = new Set(leads.map(l => l.name.toLowerCase()));
            const newLeads = result.value.filter(
              l => l.name && !existingNames.has(l.name.toLowerCase()) && !excludeNameSet.has(l.name.toLowerCase())
            );
            leads = [...leads, ...newLeads];
          }
        }
        await setPartialLeads(orgId, jobId, leads);
      }
      if (await isCancelled(orgId, jobId)) return;
    }

    // -----------------------------------------------------------
    // Phase 6 — Enriching profiles and avatars (BrightData or Scraper Pool)
    // -----------------------------------------------------------
    let enrichedLeads: PartialLead[] = leads;
    let enrichmentApplied = false;
    const leadsWithLinkedIn = leads.filter(l => l.linkedinUrl);

    if (leadsWithLinkedIn.length > 0) {
      await updateFindLeadsJobPhase(orgId, jobId, {
        phase: 6,
        phaseLabel: 'Enriching profiles and avatars…',
        percentComplete: 72,
      });

      // Try BrightData first (premium, best results)
      if (isBrightDataConfigured()) {
        try {
          const enrichmentInputs = leads.map(l => ({
            name: l.name, company: l.company, linkedinUrl: l.linkedinUrl, website: l.website,
          }));
          const enrichmentResults = await enrichLeadsWithBrightData(enrichmentInputs);
          if (enrichmentResults.size > 0) {
            enrichmentApplied = true;
            enrichedLeads = leads.map((lead, index) => {
              const enrichment = enrichmentResults.get(index);
              if (!enrichment) return lead;

              // Validate enriched contact data
              const validated = validateContactData(
                enrichment.email || lead.email,
                enrichment.phone || lead.phone,
                lead.companyDomain
              );

              return {
                ...lead,
                email: validated.email || lead.email || '',
                phone: validated.phone || lead.phone || '',
                twitterUrl: lead.twitterUrl || enrichment.twitterUrl || '',
                githubUrl: lead.githubUrl || enrichment.githubUrl || '',
                facebookUrl: lead.facebookUrl || enrichment.facebookUrl || '',
                avatar: enrichment.avatar || '',
                location: lead.location || enrichment.location || '',
              };
            });
            await setPartialLeads(orgId, jobId, enrichedLeads);
          }
        } catch (err) {
          console.error('[find-leads-runner] BrightData enrichment failed (non-fatal):', err);
        }
      }

      // Fallback: Use Scraper Pool for LinkedIn (if BrightData unavailable or failed)
      // Only process leads that still need enrichment after BrightData attempt
      const { isScraperPoolConfigured, scrapeViaPool } = await import('@/server/discovery/scraper-pool-client');
      if (isScraperPoolConfigured()) {
        const needsPoolEnrichment = enrichedLeads.filter(l =>
          l.linkedinUrl && (!l.email || !l.phone || !l.avatar)
        );

        if (needsPoolEnrichment.length > 0) {
          console.log('[find-leads-runner] Using Scraper Pool for', needsPoolEnrichment.length, 'LinkedIn profiles');

          // Scrape LinkedIn profiles with Playwright (bypass anti-bot)
          const poolPromises = needsPoolEnrichment.slice(0, 10).map(async (lead) => {
            try {
              // Use 'dynamic' kind for JavaScript-rendered LinkedIn pages
              const result = await scrapeViaPool(lead.linkedinUrl!, {
                kind: 'raw',
                timeoutMs: 15000,
              });

              if (!result || result.kind !== 'raw') return lead;

              // Extract contact info from raw HTML
              const html = result.html;
              const text = result.text;

              // Email extraction
              const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
              const emails = Array.from(new Set((text.match(emailRegex) || []).map(e => e.toLowerCase())));

              // Phone extraction (look for tel: links and visible patterns)
              const telLinkRegex = /tel:([^"'\s]+)/gi;
              const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
              const telMatches = [...html.matchAll(telLinkRegex)].map(m => m[1]);
              const textPhones = text.match(phoneRegex) || [];
              const allPhones = [...telMatches, ...textPhones];

              // Avatar extraction (LinkedIn profile images)
              const avatarRegex = /<img[^>]+class="[^"]*profile[^"]*"[^>]+src="([^"]+)"/gi;
              const avatarMatch = avatarRegex.exec(html);
              const avatar = avatarMatch?.[1];

              // Validate and apply
              const validated = validateContactData(
                emails[0] || lead.email,
                allPhones[0] || lead.phone,
                lead.companyDomain
              );

              enrichmentApplied = true;
              return {
                ...lead,
                email: validated.email || lead.email,
                phone: validated.phone || lead.phone,
                avatar: avatar || lead.avatar,
              };
            } catch (err) {
              console.warn('[find-leads-runner] Scraper Pool LinkedIn scrape failed for', lead.name, err);
              return lead;
            }
          });

          const poolResults = await Promise.allSettled(poolPromises);
          poolResults.forEach((r, idx) => {
            if (r.status === 'fulfilled') {
              const leadIndex = enrichedLeads.findIndex(l => l === needsPoolEnrichment[idx]);
              if (leadIndex !== -1) enrichedLeads[leadIndex] = r.value;
            }
          });

          await setPartialLeads(orgId, jobId, enrichedLeads);
        }
      } else if (!isBrightDataConfigured()) {
        console.warn('[find-leads-runner] No LinkedIn enrichment available - BrightData and Scraper Pool both unconfigured');
      }

      if (await isCancelled(orgId, jobId)) return;
    }

    // -----------------------------------------------------------
    // Phase 7 — Finding verified email addresses & phone numbers
    // -----------------------------------------------------------
    await updateFindLeadsJobPhase(orgId, jobId, {
      phase: 7,
      phaseLabel: 'Finding verified email addresses…',
      percentComplete: 85,
    });
    try {
      // Phase 7a — resolve company domains once per company, not once per lead.
      //
      // This used to sit inside the per-lead loop below, so five people at the
      // same restaurant each paid for their own lookup, and because the loop
      // runs in concurrent batches an in-process memo could not catch them
      // either. Deduping here is what makes a 60-lead Deep run affordable.
      const domainBudget = createSearchBudget(body.searchDepth === 'deep' ? 40 : 20);
      resetDomainRunCache();
      const domainMap = await resolveCompanyDomains(
        enrichedLeads
          .filter((l) => l.company && l.company !== 'Unknown')
          .map((l) => ({
            company: l.company,
            location: l.location || locationHint,
            region: regionHint,
            website: l.website,
          })),
        { budget: domainBudget, concurrency: 4 },
      );
      console.log('[find-leads-runner] domains resolved:',
        Array.from(domainMap.values()).filter(Boolean).length, '/', domainMap.size,
        '(searches spent:', domainBudget.spent + ')');

      const enrichLeadEmail = async (lead: PartialLead): Promise<PartialLead> => {
        if (lead.email && lead.phone) return lead;

        // Step 1: Resolve domain
        let domain: string | null =
          lead.companyDomain || extractDomain(lead.website || '') || domainFor(domainMap, lead.company);
        if (domain && !lead.companyDomain) lead = { ...lead, companyDomain: domain };

        // Step 2: Scrape company contact page FIRST (often has both email & phone)
        const websiteUrl = lead.website || (domain ? `https://${domain}` : null);
        if (websiteUrl) {
          try {
            const contactResult = await scrapeContactPageForEmail(websiteUrl);

            // Validate scraped contact data
            const validated = validateContactData(
              contactResult.email || lead.email,
              contactResult.phone || lead.phone,
              domain || lead.companyDomain
            );

            if (validated.email && !lead.email) lead = { ...lead, email: validated.email };

            // Smart phone filtering: For Indian prospects, prefer Indian numbers (+91) over US numbers
            // Avoids generic US business lines when we can find regional contact info
            if (validated.phone && !lead.phone) {
              const isIndianLead = lead.location?.toLowerCase().includes('india') ||
                                    lead.company?.toLowerCase().includes('india') ||
                                    (lead.website && lead.website.endsWith('.in'));
              const isIndianPhone = validated.phone.startsWith('+91');
              const isUSPhone = validated.phone.startsWith('+1');

              // Only accept US phone for Indian leads if no better option exists
              if (isIndianLead && isUSPhone) {
                // Skip for now, might find Indian number later
              } else {
                lead = { ...lead, phone: validated.phone };
              }
            }
          } catch { /* non-fatal */ }
        }

        // Step 3: If still no email, try pattern matching + smart verification (catch-all aware)
        if (!lead.email && domain && lead.name && lead.name !== 'Unknown') {
          try {
            const candidates = generateEmailCandidates(lead.name, domain);
            let bestEmail: string | null = null;
            let bestConfidence: 'high' | 'medium' | 'low' = 'low';

            // Try more patterns (increased from 6 to 12)
            for (const candidate of candidates.slice(0, 12)) {
              const result = await verifyEmailSmart(candidate.email, domain);
              if (result.verified) {
                // Keep track of best result (prefer high confidence).
                //
                // The medium branch below used to also test
                // `bestConfidence !== 'high'`. That was dead code: the high
                // branch always breaks, so bestConfidence can never hold
                // 'high' by the time the test runs.
                if (result.confidence === 'high') {
                  lead = { ...lead, email: candidate.email, emailVerified: true };
                  break; // Found high-confidence email, stop searching
                } else if (result.confidence === 'medium') {
                  bestEmail = candidate.email;
                  bestConfidence = 'medium';
                } else if (!bestEmail) {
                  bestEmail = candidate.email;
                  bestConfidence = 'low';
                }
              }
            }

            // If no high-confidence email found, use best available
            if (!lead.email && bestEmail) {
              lead = { ...lead, email: bestEmail, emailVerified: true };
            }
          } catch { /* non-fatal */ }
        }

        // Step 4: If we have LinkedIn but no email/phone, try BrightData as last resort
        if ((!lead.email || !lead.phone) && lead.linkedinUrl && isBrightDataConfigured()) {
          try {
            const enrichmentResults = await enrichLeadsWithBrightData([{
              name: lead.name,
              company: lead.company,
              linkedinUrl: lead.linkedinUrl,
              website: lead.website,
            }]);
            const enrichment = enrichmentResults.get(0);
            if (enrichment) {
              // Validate before applying
              const validated = validateContactData(
                enrichment.email || lead.email,
                enrichment.phone || lead.phone,
                lead.companyDomain
              );
              if (validated.email && !lead.email) lead = { ...lead, email: validated.email };
              if (validated.phone && !lead.phone) lead = { ...lead, phone: validated.phone };
              if (enrichment.avatar && !lead.avatar) lead = { ...lead, avatar: enrichment.avatar };
            }
          } catch { /* non-fatal */ }
        }

        return lead;
      };
      const batchSize = searchConfig.contactScrapeBatchSize;
      const finalLeads: PartialLead[] = [];
      for (let i = 0; i < enrichedLeads.length; i += batchSize) {
        if (await isCancelled(orgId, jobId)) return;
        const batch = enrichedLeads.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(l => enrichLeadEmail(l)));
        batchResults.forEach((r, idx) => {
          finalLeads.push(r.status === 'fulfilled' ? r.value : batch[idx]);
        });
        // Heartbeat partial results after each batch so the UI animates.
        await setPartialLeads(orgId, jobId, [...finalLeads, ...enrichedLeads.slice(finalLeads.length)]);
      }
      enrichedLeads = finalLeads;

      // Step 5: Apollo fallback for remaining leads without email/phone
      // Only run if Apollo is configured AND we have leads still missing contact data
      const needsApolloFallback = enrichedLeads.filter(l => (!l.email || !l.phone) && l.name && l.company);
      if (isApolloConfigured() && needsApolloFallback.length > 0) {
        console.log('[find-leads-runner] Using Apollo fallback for', needsApolloFallback.length, 'leads missing contact data');
        const apolloPromises = needsApolloFallback.slice(0, 10).map(async (lead) => {
          try {
            const { apolloPeopleMatch } = await import('@/server/discovery/apollo');
            const match = await apolloPeopleMatch(lead.name, lead.company!);
            if (!match) return lead;

            // Validate Apollo data before applying
            const validated = validateContactData(
              match.email || lead.email,
              match.phone || lead.phone,
              lead.companyDomain
            );

            return {
              ...lead,
              email: validated.email || lead.email,
              phone: validated.phone || lead.phone,
              title: match.title || lead.title,
              linkedinUrl: match.linkedinUrl || lead.linkedinUrl,
            };
          } catch {
            return lead; // Non-fatal
          }
        });

        const apolloResults = await Promise.allSettled(apolloPromises);
        apolloResults.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            const leadIndex = enrichedLeads.findIndex(l => l === needsApolloFallback[idx]);
            if (leadIndex !== -1) enrichedLeads[leadIndex] = r.value;
          }
        });
        await setPartialLeads(orgId, jobId, enrichedLeads);
      }
    } catch (err) {
      console.error('[find-leads-runner] Email enrichment failed (non-fatal):', err);
    }
    if (await isCancelled(orgId, jobId)) return;

    // -----------------------------------------------------------
    // Phase 8 — Finalising your list (Deep-mode company signals + billing)
    // -----------------------------------------------------------
    await updateFindLeadsJobPhase(orgId, jobId, {
      phase: 8,
      phaseLabel: 'Finalising your list…',
      percentComplete: 95,
    });

    const searchDepth: SearchDepth = (body.searchDepth as SearchDepth) || 'quick';
    if (searchDepth === 'deep' && enrichedLeads.length > 0) {
      try {
        const uniqueCompanies = new Map<string, { name: string; domain?: string }>();
        for (const lead of enrichedLeads) {
          if (lead.company && !uniqueCompanies.has(lead.company.toLowerCase())) {
            uniqueCompanies.set(lead.company.toLowerCase(), {
              name: lead.company,
              domain: lead.companyDomain || extractDomain(lead.website || '') || undefined,
            });
          }
        }
        const companyEntries = Array.from(uniqueCompanies.values()).slice(0, 5);
        const [companyResults, intentResults] = await Promise.allSettled([
          enrichCompanies(companyEntries, 3),
          Promise.allSettled(
            companyEntries.map(c => getIntentSignals(c.name, c.domain).then(signals => ({ name: c.name, signals })))
          ),
        ]);
        const companyMap = companyResults.status === 'fulfilled' ? companyResults.value : new Map();
        const intentMap = new Map<string, unknown>();
        if (intentResults.status === 'fulfilled') {
          for (const r of intentResults.value) {
            if (r.status === 'fulfilled') intentMap.set(r.value.name.toLowerCase(), r.value.signals);
          }
        }
        enrichedLeads = enrichedLeads.map(lead => {
          const companyKey = (lead.company || '').toLowerCase();
          const companyEnrichment = companyMap.get(lead.company) || companyMap.get(companyKey);
          const intentSignals = intentMap.get(companyKey);
          return {
            ...lead,
            ...(companyEnrichment && Object.keys(companyEnrichment).length > 0 ? { companyEnrichment } : {}),
            ...(intentSignals ? { intentSignals: intentSignals as Record<string, unknown> } : {}),
          };
        });
      } catch (err) {
        console.error('[find-leads-runner] Company enrichment + intent failed (non-fatal):', err);
      }
    }

    // Credit truncation + consumption
    const totalCost = calculateTotalLeadsCost(enrichedLeads, searchDepth);
    let billedLeads: PartialLead[] = enrichedLeads;
    let actualCost = totalCost;
    let truncated = false;
    let originalCount = enrichedLeads.length;
    if (totalCost > creditBalance) {
      const result = truncateLeadsToBudget(enrichedLeads, creditBalance, searchDepth);
      billedLeads = result.leads as PartialLead[];
      actualCost = result.cost;
      truncated = result.truncated;
      originalCount = result.originalCount;
    }
    if (actualCost > 0) {
      // Build a rich description + structured context so the credit log
      // shows *what* was charged for, not just "Used X credits for
      // lead_generation". The billing Lambda auto-builds a fallback if we
      // omit description, but we supply a concise one here.
      const queryForLog = body.mode === 'filters'
        ? [body.jobTitles, body.industries?.join(', '), body.locations]
            .filter(Boolean)
            .join(' · ')
        : (body.prompt || '').slice(0, 120);
      const description = `Find Leads — ${billedLeads.length} prospect${billedLeads.length === 1 ? '' : 's'} extracted${queryForLog ? ` for "${queryForLog}"` : ''}`;
      await getBillingProvider().consume(billingCtx, 'lead_generation', actualCost, {
        description,
        context: {
          surface: 'ai_hub.find_leads',
          mode: body.mode,
          searchDepth,
          query: queryForLog,
          resultCount: billedLeads.length,
          originalResultCount: originalCount,
          truncated,
          sources,
        },
        parentTransactionId,
      });
    }

    const metadata: Record<string, unknown> = {
      searchDepth,
      sources,
      queriesExecuted: limitedQueries.length,
      resultsFound: uniqueResults.length,
      pagesScraped: scrapedContents.length,
      leadsExtracted: billedLeads.length,
      enrichmentApplied,
      hasMore: billedLeads.length >= 1,
      creditCost: actualCost,
      truncated,
      searchProviderUnavailable,
      ...(truncated ? {
        truncationReason: `Returned ${billedLeads.length} of ${originalCount} leads due to credit balance`,
        originalLeadCount: originalCount,
      } : {}),
    };

    await markJobCompleted(orgId, jobId, {
      partialLeads: billedLeads,
      summary: (extractionResult.summary as string | undefined) || '',
      metadata,
    });
  } catch (err) {
    const { code, message } = classifyError(err);
    // Log the full error shape so ai_unavailable failures can be diagnosed
    // without re-running. Bedrock SDK errors carry useful context on
    // `.name` (e.g. AccessDeniedException, ValidationException,
    // ThrottlingException, ModelStreamErrorException) and `.$metadata`.
    const errName = (err as { name?: string })?.name;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errMeta = (err as { $metadata?: unknown })?.$metadata;
    console.error('[find-leads-runner] Job failed', {
      jobId,
      orgId,
      code,
      errName,
      errMsg,
      errMeta,
      stack: err instanceof Error ? err.stack : undefined,
    });
    await markJobFailed(orgId, jobId, code, message).catch(() => { /* swallow */ });
  }
}
