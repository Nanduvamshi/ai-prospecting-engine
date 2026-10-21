/**
 * Contact Graph — confidence scoring + freshness decay.
 *
 * Each record has a confidenceScore (0-100). Scoring is deterministic and
 * rule-based (no LLM) so decisions are explainable and auditable:
 *
 *   Starts at INITIAL_CONFIDENCE on first sighting.
 *   +CROSS_CONTRIBUTOR_BONUS per additional contributor (different org).
 *   +VERIFICATION_BONUS on each Bouncer re-verification.
 *   Decays -FRESHNESS_DECAY_PER_WEEK per week after FRESHNESS_GRACE_DAYS.
 *   Hidden from lookups when below CONFIDENCE_HIDE_THRESHOLD.
 *   Scheduled for deletion when below CONFIDENCE_DELETE_THRESHOLD.
 */

import {
  CONFIDENCE_DELETE_THRESHOLD,
  CONFIDENCE_HIDE_THRESHOLD,
  CROSS_CONTRIBUTOR_BONUS,
  FRESHNESS_DECAY_PER_WEEK,
  FRESHNESS_GRACE_DAYS,
  INITIAL_CONFIDENCE,
  VERIFICATION_BONUS,
} from './config';

export interface FreshnessSnapshot {
  lastVerifiedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sightingCount: number;
  /** Number of distinct contributor orgs that have seen this contact */
  contributorCount: number;
}

export function computeBaselineConfidence(snapshot: FreshnessSnapshot): number {
  let score = INITIAL_CONFIDENCE;

  // Bonus per additional contributor (beyond the first)
  if (snapshot.contributorCount > 1) {
    score += (snapshot.contributorCount - 1) * CROSS_CONTRIBUTOR_BONUS;
  }

  // Bonus if verified at least once
  if (snapshot.lastVerifiedAt) {
    score += VERIFICATION_BONUS;
  }

  return Math.min(100, Math.max(0, score));
}

export function applyDecay(baseline: number, snapshot: FreshnessSnapshot, now: Date = new Date()): number {
  const refDate = snapshot.lastVerifiedAt || snapshot.lastSeenAt;
  if (!refDate) return baseline;

  const refMs = Date.parse(refDate);
  if (!refMs) return baseline;

  const graceMs = FRESHNESS_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const overdueMs = now.getTime() - refMs - graceMs;
  if (overdueMs <= 0) return baseline;

  const weeksOverdue = overdueMs / (7 * 24 * 60 * 60 * 1000);
  const decay = Math.floor(weeksOverdue) * FRESHNESS_DECAY_PER_WEEK;
  return Math.max(0, baseline - decay);
}

/** Combined: baseline + decay for a contact snapshot */
export function currentConfidence(snapshot: FreshnessSnapshot, now: Date = new Date()): number {
  return applyDecay(computeBaselineConfidence(snapshot), snapshot, now);
}

export function isQueryable(score: number): boolean {
  return score >= CONFIDENCE_HIDE_THRESHOLD;
}

export function shouldDelete(score: number): boolean {
  return score < CONFIDENCE_DELETE_THRESHOLD;
}
