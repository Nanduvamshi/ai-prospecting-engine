/**
 * Prospect domain types.
 *
 * Only what a prospecting engine actually uses — no Deal, Ticket, Pipeline or
 * Campaign entities.
 */

export type ProspectStatus =
  | 'new'
  | 'researching'
  | 'qualified'
  | 'contacted'
  | 'converted'
  | 'disqualified';

export type ProspectSource =
  | 'linkedin'
  | 'website'
  | 'referral'
  | 'event'
  | 'manual'
  | 'import';

export const PROSPECT_STATUSES: ProspectStatus[] = [
  'new',
  'researching',
  'qualified',
  'contacted',
  'converted',
  'disqualified',
];

export const PROSPECT_SOURCES: ProspectSource[] = [
  'linkedin',
  'website',
  'referral',
  'event',
  'manual',
  'import',
];

export interface Prospect {
  prospectId: string;
  orgId: string;

  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  avatar?: string;

  source: ProspectSource;
  status: ProspectStatus;
  /** 0-100 qualification score. */
  score: number;

  notes?: string;
  tags?: string[];

  /** Company enrichment, intent signals, seniority, verification flags. */
  enrichment?: Record<string, unknown>;
  /** Which provider populated each field — drives the provenance badges. */
  enrichmentSources?: Record<string, string>;

  lastActivityDate?: string;
  contactedAt?: string;
  convertedContactId?: string;

  ownerId: string;
  ownerName: string;

  importBatchId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  contactId: string;
  orgId: string;
  name: string;
  email: string;
  phone?: string;
  companyName?: string;
  jobTitle?: string;
  website?: string;
  status: string;
  lifecycle: string;
  score: number;
  tags?: string[];
  convertedFromProspectId?: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportBatch {
  batchId: string;
  orgId: string;
  userId: string;
  userName?: string;
  filename?: string;
  totalRows: number;
  imported: number;
  skipped: number;
  duplicates: number;
  status: string;
  progress?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  undoneAt?: string;
  /** Whether the 24-hour undo window is still open. */
  canUndo: boolean;
}

export function generateProspectId(): string {
  return `prospect_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function generateContactId(): string {
  return `contact_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function generateBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isValidStatus(value: unknown): value is ProspectStatus {
  return typeof value === 'string' && (PROSPECT_STATUSES as string[]).includes(value);
}

export function isValidSource(value: unknown): value is ProspectSource {
  return typeof value === 'string' && (PROSPECT_SOURCES as string[]).includes(value);
}
