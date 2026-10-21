/**
 * Contact Graph — shared type definitions.
 */

export interface ContactRecord {
  /** sha256 of the normalized email address — primary identity key */
  contactHash: string;
  email: string;
  name?: string;
  title?: string;
  company?: string;
  companyDomain?: string;
  phone?: string;
  linkedinUrl?: string;
  /** 0-100, decays over time — see freshness.ts */
  confidenceScore: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt?: string;
  sightingCount: number;
}

export interface ContactContribution {
  contactHash: string;
  orgId: string;
  /** User who contributed the sighting — not always the same as the prospect themselves */
  userId: string;
  /** Where this sighting came from (email_signature, manual, import, etc.) */
  source: 'email_signature' | 'email_header' | 'manual' | 'import';
  /** The message id / thread id if the signature was parsed from an email */
  sourceRef?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ContactVerification {
  contactHash: string;
  verifiedAt: string;
  /** Current deliverability status from Bouncer */
  result: 'verified' | 'invalid' | 'risky' | 'unknown';
  /** If true, scheduled deletion on next sweep */
  markForDeletion?: boolean;
}

/** Extracted-but-not-stored signature data produced by the signature extractor */
export interface ExtractedSignature {
  email: string;
  name?: string;
  title?: string;
  company?: string;
  phone?: string;
  linkedinUrl?: string;
  /** 0-1 — how confident the extractor is that this is a real signature vs a random paragraph */
  extractorConfidence: number;
}

/** Opt-in state for an org's participation in the graph */
export interface OrgContactGraphParticipation {
  orgId: string;
  optedIn: boolean;
  optedInAt?: string;
  optedInBy?: string;
  optedOutAt?: string;
  optedOutBy?: string;
}

/** Response shape for /api/contact-graph/lookup */
export interface ContactLookupResult {
  found: boolean;
  contact?: Omit<ContactRecord, 'contactHash'>;
  /** Contributor org/user IDs — returned only to orgs that are themselves contributing */
  contributorCount?: number;
  /** True if the calling org itself contributed to this record */
  callerContributed?: boolean;
}
