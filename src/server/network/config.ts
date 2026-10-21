/**
 * Contact Graph — feature-flag + config.
 *
 * ⚠️ Phase 3 of the lead-gen roadmap.
 *
 * This module IS LEGALLY SENSITIVE. Extracting and aggregating contact data
 * from user email inboxes raises GDPR / CCPA / data-sharing concerns that
 * MUST be reviewed by legal counsel before any production data collection.
 *
 * All code in src/lib/contact-graph/* is gated by `isContactGraphEnabled()`
 * which reads `CONTACT_GRAPH_ENABLED` env var.
 *
 * The ONE place that actually starts collecting data — the hook in the
 * imap-sync-worker Lambda — is DELIBERATELY NOT WIRED in this commit.
 * It is left as a TODO that engineering flips only after:
 *   1. Legal review complete
 *   2. Privacy-policy amendment shipped
 *   3. DPA template available for enterprise customers
 *   4. Org-level opt-in UI in production
 *
 * Do not short-circuit any of these.
 */

export function isContactGraphEnabled(): boolean {
  return process.env.CONTACT_GRAPH_ENABLED === 'true';
}

/** Minimum confidence score below which contacts are hidden from lookups */
export const CONFIDENCE_HIDE_THRESHOLD = 20;

/** Confidence score below which contacts are scheduled for deletion */
export const CONFIDENCE_DELETE_THRESHOLD = 10;

/** Days after last verification before confidence decay begins */
export const FRESHNESS_GRACE_DAYS = 90;

/** Confidence points deducted per week past the grace period */
export const FRESHNESS_DECAY_PER_WEEK = 1;

/** Confidence bonus for a successful Bouncer re-verification */
export const VERIFICATION_BONUS = 20;

/** Confidence bonus per additional contributor (different org seeing same contact) */
export const CROSS_CONTRIBUTOR_BONUS = 10;

/** Initial confidence on first sighting */
export const INITIAL_CONFIDENCE = 50;

/** TTL in seconds for raw contact records (rolling 180 days) */
export const CONTACT_TTL_SECONDS = 180 * 24 * 60 * 60;
