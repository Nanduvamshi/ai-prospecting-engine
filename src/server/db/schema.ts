/**
 * Postgres schema.
 *
 * This replaces a DynamoDB single-table design that had spread prospecting
 * state across three physical tables: find-leads jobs and prospects in
 * `tools`, everything else (sweeps, caches, contact graph, sequences, ICP)
 * in the `whatsapp` table as a junk drawer, and an enrichment cache in `crm`
 * under the literal partition key 'ENRICHMENT_CACHE'.
 *
 * A few access patterns are deliberately better here than they were:
 *   - `sequence_enrollments` gets a partial index + SKIP LOCKED, replacing a
 *     cross-org table Scan that self-documented as "fine until 10k rows" and
 *     was not safe to run on two instances at once.
 *   - `enrichment_cache` gets a real primary key instead of one hot partition.
 *   - Prospect ordering uses real numeric comparison; the DynamoDB sort key
 *     was the string "<score>#<id>", so "9#x" sorted after "85#y".
 */
import {
  pgTable, text, integer, real, boolean, timestamp, jsonb, bigserial,
  index, uniqueIndex, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { PartialLead, FindLeadsJobRequest } from '@/server/pipeline/types';
import type { SequenceStep, EnrollmentHistoryEntry } from '@/server/outreach/sequences/types';
import type { CustomerICP } from '@/server/icp/fit-scoring';

// ─── Tenancy ──────────────────────────────────────────────────────────────

export const orgs = pgTable('orgs', {
  orgId: text('org_id').primaryKey(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  orgId: text('org_id').notNull(),
  email: text('email').notNull(),
  name: text('name'),
  role: text('role').notNull().default('member'),
  cognitoSub: text('cognito_sub'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('users_org_idx').on(t.orgId),
  uniqueIndex('users_cognito_sub_idx').on(t.cognitoSub),
]);

// ─── Find-leads jobs ──────────────────────────────────────────────────────
// Split across two tables on purpose. A run does ~8 phase heartbeats and ~6
// partial-lead writes. Keeping the (potentially ~200KB) lead blob in its own
// table means the frequent cheap writes never rewrite it, and fillfactor 70
// on the parent leaves room for HOT updates.

export const findLeadsJobs = pgTable('find_leads_jobs', {
  jobId: text('job_id').primaryKey(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('queued'),
  phase: integer('phase').notNull().default(0),
  phaseLabel: text('phase_label').notNull().default(''),
  percentComplete: integer('percent_complete').notNull().default(0),
  searchesRun: jsonb('searches_run').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  summary: text('summary'),
  request: jsonb('request').$type<FindLeadsJobRequest>().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  estimatedSeconds: integer('estimated_seconds').notNull().default(0),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  /** Only persisted when the active billing provider needs it to settle later. */
  authToken: text('auth_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull().default(sql`now() + interval '7 days'`),
}, (t) => [
  index('jobs_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('jobs_expires_idx').on(t.expiresAt),
  // Drives the stuck-job reaper: a run is an unawaited promise, so an
  // instance recycling mid-flight would otherwise strand it in 'running'.
  index('jobs_inflight_idx').on(t.updatedAt).where(sql`status in ('queued','running')`),
  check('jobs_status_check', sql`status in ('queued','running','completed','failed','cancelled')`),
]);

export const findLeadsJobLeads = pgTable('find_leads_job_leads', {
  jobId: text('job_id').primaryKey()
    .references(() => findLeadsJobs.jobId, { onDelete: 'cascade' }),
  partialLeads: jsonb('partial_leads').$type<PartialLead[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Prospects & contacts ─────────────────────────────────────────────────

export const importBatches = pgTable('import_batches', {
  batchId: text('batch_id').primaryKey(),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  filename: text('filename'),
  totalRows: integer('total_rows').notNull().default(0),
  imported: integer('imported').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  /** Polled by the SSE progress route. Row-backed rather than in-memory so
   *  the reader and writer can land on different instances. */
  progress: jsonb('progress').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('running'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
}, (t) => [
  index('import_batches_org_idx').on(t.orgId, t.createdAt.desc()),
]);

export const prospects = pgTable('prospects', {
  prospectId: text('prospect_id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  company: text('company'),
  title: text('title'),
  linkedinUrl: text('linkedin_url'),
  website: text('website'),
  avatar: text('avatar'),
  source: text('source').notNull().default('manual'),
  status: text('status').notNull().default('new'),
  score: integer('score').notNull().default(0),
  notes: text('notes'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  /** companyEnrichment / intentSignals / emailVerified / seniority etc. */
  enrichment: jsonb('enrichment').$type<Record<string, unknown>>(),
  /** field -> provider that populated it, for the provenance badges. Folded
   *  in from what used to be a separate sister record keyed by prospect. */
  enrichmentSources: jsonb('enrichment_sources').$type<Record<string, string>>(),
  lastActivityDate: timestamp('last_activity_date', { withTimezone: true }),
  contactedAt: timestamp('contacted_at', { withTimezone: true }),
  convertedContactId: text('converted_contact_id'),
  ownerId: text('owner_id').notNull(),
  ownerName: text('owner_name').notNull().default(''),
  importBatchId: text('import_batch_id')
    .references(() => importBatches.batchId, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Default listing (no filter) and the owner + status filtered variants.
  // Each carries prospectId as a tie-breaker so keyset pagination is stable.
  index('prospects_org_created_idx').on(t.orgId, t.createdAt.desc(), t.prospectId.desc()),
  index('prospects_org_owner_idx').on(t.orgId, t.ownerId, t.createdAt.desc(), t.prospectId.desc()),
  index('prospects_org_status_score_idx').on(t.orgId, t.status, t.score.desc(), t.prospectId.desc()),
  index('prospects_org_email_idx').on(t.orgId, t.email),
  // Supports duplicate-detection's name+company pass.
  index('prospects_org_company_name_idx')
    .on(t.orgId, sql`lower(${t.company})`, sql`lower(${t.name})`),
  index('prospects_tags_idx').using('gin', t.tags),
  index('prospects_batch_idx').on(t.importBatchId).where(sql`import_batch_id is not null`),
  // Deliberately NOT unique on (org_id, email): existing data may violate it,
  // and import has explicit duplicate-detection semantics that a constraint
  // violation would change. Revisit after any backfill.
]);

export const contacts = pgTable('contacts', {
  contactId: text('contact_id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  companyName: text('company_name'),
  jobTitle: text('job_title'),
  website: text('website'),
  status: text('status').notNull().default('lead'),
  lifecycle: text('lifecycle').notNull().default('lead'),
  score: integer('score').notNull().default(0),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  convertedFromProspectId: text('converted_from_prospect_id'),
  ownerId: text('owner_id').notNull(),
  ownerName: text('owner_name').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('contacts_org_email_idx').on(t.orgId, sql`lower(${t.email})`),
  index('contacts_org_created_idx').on(t.orgId, t.createdAt.desc()),
]);

// ─── Intent signal sweeps ─────────────────────────────────────────────────

export const sweepItems = pgTable('sweep_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sweepType: text('sweep_type').notNull(),
  /** Content hash — the old sort key used it for dedupe on re-ingest. */
  itemHash: text('item_hash').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull().default(sql`now() + interval '14 days'`),
}, (t) => [
  uniqueIndex('sweep_type_hash_idx').on(t.sweepType, t.itemHash),
  index('sweep_type_time_idx').on(t.sweepType, t.ingestedAt.desc()),
  index('sweep_expires_idx').on(t.expiresAt),
  check('sweep_type_check', sql`sweep_type in ('funding','review','domain','social')`),
]);

// ─── Caches ───────────────────────────────────────────────────────────────

export const emailVerificationCache = pgTable('email_verification_cache', {
  /** sha256 of the lowercased email. Hashed so no raw address sits in a key. */
  emailHash: text('email_hash').primaryKey(),
  status: text('status').notNull(),
  reason: text('reason').notNull().default(''),
  mxUsed: text('mx_used'),
  source: text('source').notNull(),
  cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('email_verify_expires_idx').on(t.expiresAt)]);

export const enrichmentCache = pgTable('enrichment_cache', {
  cacheKey: text('cache_key').primaryKey(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('enrichment_cache_expires_idx').on(t.expiresAt)]);

/** Single row. Keeps the existing string[] store signature intact — and
 *  unlike DynamoDB there is no 400KB item ceiling, which the upstream
 *  ~100k-domain blocklist comfortably exceeded. */
export const disposableDomains = pgTable('disposable_domains', {
  id: integer('id').primaryKey().default(1),
  domains: jsonb('domains').$type<string[]>().notNull(),
  count: integer('count').notNull().default(0),
  source: text('source').notNull().default('github'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('disposable_singleton_check', sql`${t.id} = 1`)]);

export const techScans = pgTable('tech_scans', {
  domain: text('domain').notNull(),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
  technologies: jsonb('technologies').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull().default(sql`now() + interval '90 days'`),
}, (t) => [
  primaryKey({ columns: [t.domain, t.scannedAt] }),
  index('tech_scans_expires_idx').on(t.expiresAt),
]);

// ─── ICP ──────────────────────────────────────────────────────────────────

export const orgIcp = pgTable('org_icp', {
  orgId: text('org_id').notNull(),
  /** Composite so per-product ICPs are possible later without a migration. */
  icpKey: text('icp_key').notNull().default('default'),
  icp: jsonb('icp').$type<CustomerICP>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
}, (t) => [primaryKey({ columns: [t.orgId, t.icpKey] })]);

// ─── Outreach sequences ───────────────────────────────────────────────────

export const sequences = pgTable('sequences', {
  sequenceId: text('sequence_id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  steps: jsonb('steps').$type<SequenceStep[]>().notNull().default(sql`'[]'::jsonb`),
  exitOnReply: boolean('exit_on_reply').notNull().default(true),
  icpFilter: text('icp_filter'),
  status: text('status').notNull().default('active'),
  enrolledCount: integer('enrolled_count').notNull().default(0),
  completedCount: integer('completed_count').notNull().default(0),
  exitedCount: integer('exited_count').notNull().default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sequences_org_idx').on(t.orgId, t.createdAt.desc())]);

export const sequenceEnrollments = pgTable('sequence_enrollments', {
  enrollmentId: text('enrollment_id').primaryKey(),
  orgId: text('org_id').notNull(),
  sequenceId: text('sequence_id').notNull()
    .references(() => sequences.sequenceId, { onDelete: 'cascade' }),
  prospectEmail: text('prospect_email').notNull(),
  prospectName: text('prospect_name'),
  prospectCompany: text('prospect_company'),
  enrolledBy: text('enrolled_by'),
  status: text('status').notNull().default('running'),
  currentStepIndex: integer('current_step_index').notNull().default(0),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastAdvancedAt: timestamp('last_advanced_at', { withTimezone: true }),
  exitReason: text('exit_reason'),
  history: jsonb('history').$type<EnrollmentHistoryEntry[]>().notNull().default(sql`'[]'::jsonb`),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('enrollments_org_seq_idx').on(t.orgId, t.sequenceId),
  // The runner's hot path. Partial, so it stays an index-only range scan no
  // matter how many completed enrollments accumulate.
  index('enrollments_due_idx').on(t.nextRunAt).where(sql`status = 'running'`),
  // exit-on-reply lookup by prospect.
  index('enrollments_active_email_idx')
    .on(t.orgId, sql`lower(${t.prospectEmail})`).where(sql`status = 'running'`),
]);

// ─── Contact graph ────────────────────────────────────────────────────────
// The DynamoDB layout faked a one-to-many with sort-key prefixes under a
// single partition (META | CONTRIB#<org>#<user> | VERIFICATION#<ts>).
// Relationally it just is a one-to-many, so it becomes three tables.

export const cgContacts = pgTable('cg_contacts', {
  /** sha256 slice of the lowercased email — no raw PII in the key space. */
  contactHash: text('contact_hash').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  title: text('title'),
  company: text('company'),
  companyDomain: text('company_domain'),
  phone: text('phone'),
  linkedinUrl: text('linkedin_url'),
  confidenceScore: real('confidence_score').notNull().default(0),
  sightingCount: integer('sighting_count').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [index('cg_contacts_email_idx').on(sql`lower(${t.email})`)]);

export const cgContributions = pgTable('cg_contributions', {
  contactHash: text('contact_hash').notNull()
    .references(() => cgContacts.contactHash, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  source: text('source').notNull().default('manual'),
  /** Message or thread id, when the sighting came from a parsed signature. */
  sourceRef: text('source_ref'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.contactHash, t.orgId, t.userId] }),
  // Makes "delete everything my org contributed" one statement instead of a
  // full-table scan plus batched deletes.
  index('cg_contrib_org_user_idx').on(t.orgId, t.userId),
]);

export const cgVerifications = pgTable('cg_verifications', {
  contactHash: text('contact_hash').notNull()
    .references(() => cgContacts.contactHash, { onDelete: 'cascade' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  result: text('result').notNull(),
  markForDeletion: boolean('mark_for_deletion').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.contactHash, t.verifiedAt] })]);

export const cgOrgParticipation = pgTable('cg_org_participation', {
  orgId: text('org_id').primaryKey(),
  optedIn: boolean('opted_in').notNull().default(false),
  optedInAt: timestamp('opted_in_at', { withTimezone: true }),
  optedInBy: text('opted_in_by'),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  optedOutBy: text('opted_out_by'),
});

export const cgIntroRequests = pgTable('cg_intro_requests', {
  requestId: text('request_id').primaryKey(),
  contactHash: text('contact_hash').notNull(),
  requesterOrgId: text('requester_org_id').notNull(),
  requesterUserId: text('requester_user_id').notNull(),
  targetOrgId: text('target_org_id').notNull(),
  targetUserId: text('target_user_id').notNull(),
  status: text('status').notNull().default('pending'),
  message: text('message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
}, (t) => [
  index('cg_intro_target_idx').on(t.targetOrgId, t.status, t.createdAt.desc()),
  // The inbox query. Previously a filtered table Scan with a comment saying
  // it would need a GSI to be efficient; here it is just an index.
  index('cg_intro_target_user_idx').on(t.targetUserId, t.status, t.createdAt.desc()),
  index('cg_intro_contact_idx').on(t.contactHash),
  index('cg_intro_requester_idx').on(t.contactHash, t.requesterUserId),
]);

// ─── Public data ingestion ────────────────────────────────────────────────

export const publicRoles = pgTable('public_roles', {
  companySlug: text('company_slug').notNull(),
  titleSlug: text('title_slug').notNull(),
  nameSlug: text('name_slug').notNull(),
  name: text('name'),
  title: text('title'),
  company: text('company'),
  source: text('source'),
  sourceUrl: text('source_url'),
  /** Source-specific sub-type: filing form, commit hash, and so on. */
  sourceKind: text('source_kind'),
  confidence: real('confidence'),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull().default(sql`now() + interval '180 days'`),
}, (t) => [
  primaryKey({ columns: [t.companySlug, t.titleSlug, t.nameSlug] }),
  index('public_roles_expires_idx').on(t.expiresAt),
]);

// ─── Rate limiting ────────────────────────────────────────────────────────
// The public lead-finder is unauthenticated and spends real money on LLM and
// search calls. An in-process limiter stops working the moment there is more
// than one instance, so the counters live here.

export const toolRateLimits = pgTable('tool_rate_limits', {
  bucketKey: text('bucket_key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [index('rate_limits_window_idx').on(t.windowStart)]);
