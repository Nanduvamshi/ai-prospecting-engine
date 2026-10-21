import type { Prospect } from './types';

/**
 * Initial qualification score for a newly created prospect.
 *
 * There are two sources for a prospect's score, and it has to be obvious
 * which one governs the number a user actually sees:
 *
 *   1. This additive heuristic, for manually created and imported prospects.
 *   2. The score Claude assigns to each lead during pipeline extraction,
 *      which reflects how well the lead matched the actual search intent.
 *
 * The rule: the AI score wins when the prospect
 * came out of the pipeline, because it encodes relevance to what was searched
 * for. Otherwise this heuristic applies. The rule engine in `scoring.ts` stays
 * available for rescoring on engagement, which is a different question from
 * "how promising does this look on arrival".
 *
 * This matters beyond cosmetics: score is the sort key for the status-filtered
 * list, so an ambiguous score changes what a user sees first.
 */

/** Field weights. Contactability first, then identifiability. */
const WEIGHTS = {
  base: 10,
  email: 20,
  phone: 10,
  company: 15,
  title: 10,
  linkedinUrl: 15,
} as const;

/** Maximum this heuristic can produce — deliberately below 100, since a
 *  fully-populated record is promising, not proven. */
export const MAX_HEURISTIC_SCORE =
  WEIGHTS.base + WEIGHTS.email + WEIGHTS.phone + WEIGHTS.company + WEIGHTS.title + WEIGHTS.linkedinUrl;

export type ScorableProspect = Partial<
  Pick<Prospect, 'email' | 'phone' | 'company' | 'title' | 'linkedinUrl' | 'score'>
>;

/**
 * Score a prospect on arrival.
 *
 * Pass `aiScore` when the prospect came from the find-leads pipeline; it takes
 * precedence because it reflects match quality against the search, which
 * field presence cannot capture.
 */
export function initialProspectScore(
  prospect: ScorableProspect,
  aiScore?: number,
): number {
  if (typeof aiScore === 'number' && Number.isFinite(aiScore)) {
    return Math.min(100, Math.max(0, Math.round(aiScore)));
  }

  let score = WEIGHTS.base;
  if (prospect.email) score += WEIGHTS.email;
  if (prospect.phone) score += WEIGHTS.phone;
  if (prospect.company) score += WEIGHTS.company;
  if (prospect.title) score += WEIGHTS.title;
  if (prospect.linkedinUrl) score += WEIGHTS.linkedinUrl;

  return Math.min(100, score);
}

/** Bump applied when a prospect converts — a conversion is real evidence. */
export const CONVERSION_SCORE_BONUS = 25;
