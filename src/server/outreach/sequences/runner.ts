/**
 * Sequence runner — advances enrollments whose next step is due.
 *
 * Called by the cron endpoint /api/cron/sequence-runner every 5 minutes.
 * For each due enrollment:
 *   1. Load the parent sequence definition.
 *   2. Read the step at currentStepIndex.
 *   3. Execute it (send-email / send-whatsapp / send-linkedin) or, if it's
 *      a 'wait', simply advance.
 *   4. Compute nextRunAt for the NEXT step (current time + delayDays).
 *   5. If we just executed the last step → mark enrollment 'completed'.
 *
 * Exit semantics:
 *   - Sequence.exitOnReply=true and any reply detected → caller (reply hook)
 *     marks enrollment 'exited' BEFORE the runner sees it.
 *   - Manual pause/exit happens via API.
 *   - Hard failure during execution → status='failed', exitReason='...'
 */

import { findDueEnrollments, updateEnrollment } from './enrollment-store';
import { getSequence, bumpSequenceCounter } from './sequence-store';
import type { SequenceEnrollment, SequenceStep, OutreachSequence } from './types';
import { getEmailSender } from '@/server/email';

export interface RunnerStats {
  scanned: number;
  advanced: number;
  completed: number;
  failed: number;
  skipped: number;
}

/**
 * Process up to N due enrollments. Returns per-step stats.
 *
 * Each step execution is best-effort — if a send fails, the enrollment is
 * marked 'failed' and the next ones are unaffected.
 */
export async function runSequenceBatch(opts: { limit?: number } = {}): Promise<RunnerStats> {
  const stats: RunnerStats = { scanned: 0, advanced: 0, completed: 0, failed: 0, skipped: 0 };
  const due = await findDueEnrollments(opts.limit || 50);
  stats.scanned = due.length;

  for (const enrollment of due) {
    const seq = await getSequence(enrollment.orgId, enrollment.sequenceId);
    if (!seq) {
      enrollment.status = 'failed';
      enrollment.exitReason = 'sequence_deleted';
      enrollment.history = [...(enrollment.history || []), { at: new Date().toISOString(), action: 'failed', detail: 'sequence_deleted' }];
      await updateEnrollment(enrollment.orgId, enrollment);
      stats.failed += 1;
      continue;
    }

    const step = seq.steps[enrollment.currentStepIndex];
    if (!step) {
      // No more steps — completed
      enrollment.status = 'completed';
      enrollment.history = [...(enrollment.history || []), { at: new Date().toISOString(), action: 'completed' }];
      await updateEnrollment(enrollment.orgId, enrollment);
      await bumpSequenceCounter(enrollment.orgId, enrollment.sequenceId, 'completedCount');
      stats.completed += 1;
      continue;
    }

    try {
      const result = await executeStep(seq, enrollment, step);
      const nowIso = new Date().toISOString();
      const newHistory = [...(enrollment.history || []), {
        at: nowIso,
        action: `step_${step.type}`,
        detail: result.summary,
      }];

      const nextIdx = enrollment.currentStepIndex + 1;
      if (nextIdx >= seq.steps.length) {
        // Just executed the last step
        enrollment.status = 'completed';
        enrollment.currentStepIndex = nextIdx;
        enrollment.lastAdvancedAt = nowIso;
        enrollment.history = newHistory;
        await updateEnrollment(enrollment.orgId, enrollment);
        await bumpSequenceCounter(enrollment.orgId, enrollment.sequenceId, 'completedCount');
        stats.completed += 1;
      } else {
        const nextStep = seq.steps[nextIdx];
        const nextRunAt = new Date(Date.now() + (nextStep.delayDays || 0) * 24 * 60 * 60 * 1000).toISOString();
        enrollment.currentStepIndex = nextIdx;
        enrollment.nextRunAt = nextRunAt;
        enrollment.lastAdvancedAt = nowIso;
        enrollment.history = newHistory;
        await updateEnrollment(enrollment.orgId, enrollment);
        stats.advanced += 1;
      }
    } catch (err) {
      enrollment.status = 'failed';
      enrollment.exitReason = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      enrollment.history = [...(enrollment.history || []), { at: new Date().toISOString(), action: 'failed', detail: enrollment.exitReason }];
      await updateEnrollment(enrollment.orgId, enrollment);
      await bumpSequenceCounter(enrollment.orgId, enrollment.sequenceId, 'exitedCount');
      stats.failed += 1;
    }
  }

  return stats;
}

// ─── Step execution ──────────────────────────────────────────────────

interface StepResult { summary: string; }

function applyVariables(template: string, enrollment: SequenceEnrollment): string {
  if (!template) return '';
  const firstName = (enrollment.prospectName || '').split(' ')[0] || 'there';
  return template
    .replace(/\{\{firstName\}\}/gi, firstName)
    .replace(/\{\{name\}\}/gi, enrollment.prospectName || firstName)
    .replace(/\{\{company\}\}/gi, enrollment.prospectCompany || 'your company')
    .replace(/\{\{email\}\}/gi, enrollment.prospectEmail);
}

async function executeStep(_seq: OutreachSequence, enrollment: SequenceEnrollment, step: SequenceStep): Promise<StepResult> {
  switch (step.type) {
    case 'wait':
      return { summary: `waited ${step.delayDays}d` };

    case 'send_email':
      // Delegate to the existing email-send route. Server-to-server call needs
      // an internal token so we don't go through the public auth flow.
      // For MVP we POST to /api/email/send-as-user (assumed to exist) with the
      return await sendSequenceEmail(enrollment, step);

    case 'send_whatsapp':
      return await sendSequenceWhatsApp(enrollment, step);

    case 'send_linkedin':
      return { summary: 'linkedin not implemented yet' };

    default:
      throw new Error(`unknown step type: ${(step as { type: string }).type}`);
  }
}

/**
 * Send one email step.
 *
 * The runner calls the sender directly as a function rather than POSTing
 * back into the app over HTTP — no extra hop, no shared internal secret, and
 * no dependency on knowing the app's own public URL.
 *
 * With the default log-only sender the step is recorded rather than
 * delivered, which is what makes sequences safe to exercise in development.
 */
async function sendSequenceEmail(
  enrollment: SequenceEnrollment,
  step: SequenceStep,
): Promise<StepResult> {
  const subject = applyVariables(step.subject || '', enrollment);
  const body = applyVariables(step.body || '', enrollment);

  const result = await getEmailSender().send({
    orgId: enrollment.orgId,
    fromUserId: enrollment.enrolledBy,
    to: enrollment.prospectEmail,
    subject,
    body,
  });

  const label = subject.length > 40 ? `${subject.slice(0, 40)}...` : subject;
  return {
    summary: result.simulated
      ? `recorded email "${label}" (log-only sender)`
      : `sent email "${label}"`,
  };
}

/**
 * WhatsApp steps are accepted by the data model but have no transport here.
 *
 * Returning a skip rather than throwing keeps the enrollment advancing: a
 * sequence that mixes channels should not stall permanently on the one this
 * product cannot yet deliver.
 */
async function sendSequenceWhatsApp(
  _enrollment: SequenceEnrollment,
  _step: SequenceStep,
): Promise<StepResult> {
  return { summary: 'skipped — no WhatsApp transport configured' };
}
