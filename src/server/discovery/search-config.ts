/**
 * Search Depth Configuration for Lead Generation
 * Defines tiered limits for Quick vs Deep search modes.
 */

export type SearchDepth = 'quick' | 'deep';

export interface SearchTierConfig {
  maxQueries: number;
  resultsPerQuery: number;
  maxPagesScraped: number;
  maxLeads: number;
  /** Content truncation limit per scraped page (chars) */
  contentTruncateLength: number;
  /** Max parallel contact page scraping batch size */
  contactScrapeBatchSize: number;
}

export const SEARCH_TIER_CONFIG: Record<SearchDepth, SearchTierConfig> = {
  quick: {
    maxQueries: 5,
    resultsPerQuery: 10,
    maxPagesScraped: 8,
    maxLeads: 30,
    contentTruncateLength: 5000,
    contactScrapeBatchSize: 5,
  },
  deep: {
    maxQueries: 8,
    resultsPerQuery: 20,
    maxPagesScraped: 20,
    maxLeads: 60,
    contentTruncateLength: 5000,
    contactScrapeBatchSize: 8,
  },
};

export function getSearchConfig(depth?: string): SearchTierConfig {
  if (depth === 'deep') return SEARCH_TIER_CONFIG.deep;
  return SEARCH_TIER_CONFIG.quick;
}
