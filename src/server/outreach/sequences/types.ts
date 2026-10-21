/**
 * Outreach Sequences — type definitions.
 *
 * A sequence is an ordered list of steps. Each step is either an action
 * (send an email/whatsapp/linkedin message) or a wait. Sequences run
 * per-prospect (an "enrollment").
 *
 * The runner processes enrollments on a 5-min cron tick:
 *   - For each enrollment in 'running' state:
 *     - If currentStep is wait → check if delay elapsed → advance
 *     - If currentStep is action → execute it → advance
 *   - Exit conditions (prospect replied, manually exited) short-circuit.
 */

export type StepType =
  | 'send_email'
  | 'send_whatsapp'
  | 'send_linkedin'
  | 'wait';

export interface SequenceStep {
  /** Stable id within the sequence (uuid-ish — generated client-side or in API) */
  id: string;
  type: StepType;
  /** Days to wait BEFORE this step fires (0 = fire immediately on entry) */
  delayDays: number;
  /** For send_* steps: subject line (email only — others ignore) */
  subject?: string;
  /** For send_* steps: message body. Supports {{firstName}} {{company}} {{title}} variables. */
  body?: string;
  /** Optional channel hint when step type is generic */
  channel?: 'email' | 'whatsapp' | 'linkedin';
}

export interface OutreachSequence {
  sequenceId: string;
  orgId: string;
  name: string;
  description?: string;
  /** Ordered steps */
  steps: SequenceStep[];
  /** If true, exit the enrollment if the prospect replies on any channel */
  exitOnReply: boolean;
  /** ICP filter — only enroll prospects matching this. JSON-stringified for storage. */
  icpFilter?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Counters maintained by the runner */
  enrolledCount?: number;
  completedCount?: number;
  exitedCount?: number;
}

export type EnrollmentStatus = 'running' | 'completed' | 'exited' | 'paused' | 'failed';

/** One audit-trail entry on an enrollment. Named so the persistence layer
 *  can type the JSONB column with it. */
export interface EnrollmentHistoryEntry {
  at: string;
  action: string;
  detail?: string;
}

export interface SequenceEnrollment {
  enrollmentId: string;
  sequenceId: string;
  orgId: string;
  /** Identity of the prospect being processed */
  prospectEmail: string;
  prospectName?: string;
  prospectCompany?: string;
  /** User who enrolled them (becomes outbound sender) */
  enrolledBy: string;
  status: EnrollmentStatus;
  /** Index into sequence.steps that is currently due / executing */
  currentStepIndex: number;
  /** When the current step is eligible to fire (ISO). For waits, in the future. */
  nextRunAt: string;
  /** When the enrollment started */
  enrolledAt: string;
  /** Last time the runner advanced this enrollment */
  lastAdvancedAt?: string;
  /** Why exited / failed */
  exitReason?: string;
  /** Audit trail — most recent first, max 20 entries */
  history?: EnrollmentHistoryEntry[];
}
