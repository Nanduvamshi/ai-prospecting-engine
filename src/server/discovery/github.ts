/**
 * GitHub Integration — Find tech leads via GitHub API.
 * Uses the public GitHub search API (no token required for basic searches,
 * but rate-limited to 10 requests/minute for unauthenticated).
 */

export interface GitHubLead {
  name: string;
  title: string;
  company: string;
  linkedinUrl?: string;
  website?: string;
  email?: string;
  location?: string;
  githubUrl: string;
  source: string;
  score: number;
  /** GitHub-specific metadata */
  githubData?: {
    followers: number;
    publicRepos: number;
    bio?: string;
  };
}

interface GitHubUser {
  login: string;
  html_url: string;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubUser[];
}

/**
 * Search GitHub for tech professionals matching criteria.
 * Uses GitHub's user search API.
 */
export async function searchGitHub(
  searchTerms: string,
  options?: { maxResults?: number; location?: string; company?: string },
): Promise<GitHubLead[]> {
  const maxResults = options?.maxResults || 10;

  // Build GitHub search query
  const queryParts: string[] = [];

  // Parse search terms for relevant GitHub qualifiers
  if (options?.location) {
    queryParts.push(`location:"${options.location}"`);
  }
  if (options?.company) {
    queryParts.push(`"${options.company}"`);
  }

  // Add general search terms
  queryParts.push(searchTerms);

  // Add minimum followers to filter for established profiles
  queryParts.push('followers:>10');

  const query = queryParts.join(' ');

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'prospecting-lead-finder',
  };

  // Use GitHub token if available for higher rate limits
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  try {
    const params = new URLSearchParams({
      q: query,
      sort: 'followers',
      order: 'desc',
      per_page: String(Math.min(maxResults, 30)),
    });

    const response = await fetch(`https://api.github.com/search/users?${params}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 403) {
        console.error('[GitHub] Rate limit exceeded');
        return [];
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data: GitHubSearchResponse = await response.json();

    if (!data.items || data.items.length === 0) return [];

    // Fetch detailed profiles for top results (rate-limited, so limit to 5)
    const detailedUsers: GitHubUser[] = [];
    const profilePromises = data.items.slice(0, 5).map(async (user) => {
      try {
        const profileRes = await fetch(`https://api.github.com/users/${user.login}`, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
        if (profileRes.ok) {
          return await profileRes.json() as GitHubUser;
        }
      } catch {
        // Fall back to search result data
      }
      return user;
    });

    const profileResults = await Promise.allSettled(profilePromises);
    profileResults.forEach(r => {
      if (r.status === 'fulfilled') detailedUsers.push(r.value);
    });

    // Add remaining users from search results (without detailed profiles)
    for (const user of data.items.slice(5, maxResults)) {
      detailedUsers.push(user);
    }

    return detailedUsers
      .filter(user => user.name) // Only users with a real name
      .map((user): GitHubLead => {
        // Clean company name (GitHub often has @ prefix)
        const company = (user.company || '').replace(/^@/, '').trim();

        // Score based on followers + repos + profile completeness
        let score = 30;
        if (user.followers > 100) score += 20;
        else if (user.followers > 50) score += 15;
        else if (user.followers > 10) score += 10;
        if (user.public_repos > 50) score += 10;
        if (user.email) score += 15;
        if (company) score += 10;
        if (user.bio) score += 5;
        score = Math.min(100, score);

        return {
          name: user.name || user.login,
          title: user.bio ? extractTitleFromBio(user.bio) : 'Software Developer',
          company,
          email: user.email || undefined,
          website: user.blog || undefined,
          location: user.location || '',
          githubUrl: user.html_url,
          source: user.html_url,
          score,
          githubData: {
            followers: user.followers,
            publicRepos: user.public_repos,
            bio: user.bio || undefined,
          },
        };
      });
  } catch (err) {
    console.error('[GitHub] Search failed:', err);
    return [];
  }
}

/**
 * Try to extract a job title from a GitHub bio.
 * Bios often contain "Software Engineer at Google" or "CTO @startup".
 */
function extractTitleFromBio(bio: string): string {
  // Common patterns: "Title at Company" or "Title @Company"
  const titleMatch = bio.match(/^([^.|\n]{3,50}?)(?:\s+(?:at|@)\s+\S+)/i);
  if (titleMatch) return titleMatch[1].trim();

  // Just use first part of bio if it's short enough
  const firstSentence = bio.split(/[.\n]/)[0].trim();
  if (firstSentence.length <= 50) return firstSentence;

  return 'Software Developer';
}
