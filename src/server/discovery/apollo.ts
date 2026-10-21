/**
 * Apollo.io Integration — Paid API for bulk people search with email + phone.
 * Optional: graceful degradation if APOLLO_API_KEY is not configured.
 *
 * Apollo API docs: https://apolloio.github.io/apollo-api-docs/
 */

export interface ApolloLead {
  name: string;
  title: string;
  company: string;
  companyDomain?: string;
  linkedinUrl?: string;
  website?: string;
  email?: string;
  phone?: string;
  location?: string;
  seniority?: string;
  department?: string;
  source: string;
  score: number;
}

interface ApolloPerson {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  linkedin_url: string;
  email: string;
  phone_numbers?: Array<{ raw_number: string; sanitized_number: string }>;
  city: string;
  state: string;
  country: string;
  seniority: string;
  departments: string[];
  organization?: {
    name: string;
    website_url: string;
    primary_domain: string;
    industry: string;
    estimated_num_employees: number;
  };
}

/**
 * Check if Apollo API is configured.
 */
export function isApolloConfigured(): boolean {
  return Boolean(process.env.APOLLO_API_KEY);
}

/**
 * Search Apollo.io for people matching criteria.
 * Returns leads with email + phone when available.
 */
export async function searchApollo(
  options: {
    jobTitles?: string[];
    industries?: string[];
    locations?: string[];
    companyDomains?: string[];
    maxResults?: number;
  },
): Promise<ApolloLead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return [];

  const maxResults = options.maxResults || 20;

  try {
    const body: Record<string, any> = {
      api_key: apiKey,
      page: 1,
      per_page: Math.min(maxResults, 25),
    };

    // Build person search criteria
    if (options.jobTitles && options.jobTitles.length > 0) {
      body.person_titles = options.jobTitles;
    }
    if (options.locations && options.locations.length > 0) {
      body.person_locations = options.locations;
    }
    if (options.companyDomains && options.companyDomains.length > 0) {
      body.q_organization_domains = options.companyDomains.join('\n');
    }
    if (options.industries && options.industries.length > 0) {
      body.organization_industry_tag_ids = options.industries;
    }

    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Apollo] API error ${response.status}: ${text.substring(0, 200)}`);
      return [];
    }

    const data = await response.json();
    const people: ApolloPerson[] = data.people || [];

    return people.map((person): ApolloLead => {
      const location = [person.city, person.state, person.country]
        .filter(Boolean)
        .join(', ');

      // Map Apollo seniority to our format
      const seniorityMap: Record<string, string> = {
        owner: 'C-level',
        founder: 'C-level',
        c_suite: 'C-level',
        partner: 'C-level',
        vp: 'VP',
        director: 'Director',
        manager: 'Manager',
        senior: 'Senior IC',
        entry: 'IC',
      };

      return {
        name: person.name || `${person.first_name} ${person.last_name}`,
        title: person.title || '',
        company: person.organization?.name || '',
        companyDomain: person.organization?.primary_domain || undefined,
        linkedinUrl: person.linkedin_url || undefined,
        website: person.organization?.website_url || undefined,
        email: person.email || undefined,
        phone: person.phone_numbers?.[0]?.sanitized_number || person.phone_numbers?.[0]?.raw_number || undefined,
        location,
        seniority: seniorityMap[person.seniority] || 'Unknown',
        department: person.departments?.[0] || 'Other',
        source: person.linkedin_url || 'apollo',
        score: person.email ? 80 : 60, // Higher score if email is available
      };
    });
  } catch (err) {
    console.error('[Apollo] Search failed:', err);
    return [];
  }
}

export interface ApolloMatchResult {
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  companyDomain?: string;
}

/**
 * Apollo People Match — single-person lookup by name + company.
 * Used as final enrichment fallback when pattern+Bouncer and web scraping fail.
 * Returns a pre-verified email from Apollo's contact DB if the person is found.
 */
export async function apolloPeopleMatch(
  name: string,
  company: string,
  timeoutMs: number = 8000,
): Promise<ApolloMatchResult | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey || !name || !company) return null;

  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';

  try {
    const response = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        first_name: first,
        last_name: last,
        organization_name: company,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[Apollo] people/match ${response.status}`);
      }
      return null;
    }

    const data = await response.json();
    const person = data?.person;
    if (!person || typeof person !== 'object') return null;

    const email = typeof person.email === 'string' ? person.email : undefined;
    const phone = person.phone_numbers?.[0]?.sanitized_number
      || person.phone_numbers?.[0]?.raw_number
      || undefined;

    return {
      email,
      phone: typeof phone === 'string' ? phone : undefined,
      title: typeof person.title === 'string' ? person.title : undefined,
      linkedinUrl: typeof person.linkedin_url === 'string' ? person.linkedin_url : undefined,
      companyDomain: typeof person.organization?.primary_domain === 'string'
        ? person.organization.primary_domain
        : undefined,
    };
  } catch (err) {
    console.error('[Apollo] people/match failed:', err);
    return null;
  }
}
