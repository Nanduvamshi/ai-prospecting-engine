'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PaperPlaneTilt, Clock, EnvelopeSimple, ArrowClockwise, CaretRight, CaretDown, Warning,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { api, ApiError } from '@/lib/api-client';

/**
 * Outreach sequences.
 *
 * Steps advance on a five-minute server cron rather than in the browser. A
 * client-side runner would mean sequences only progress while somebody has
 * the tab open.
 */

interface SequenceStep {
  id: string;
  type: 'send_email' | 'send_whatsapp' | 'send_linkedin' | 'wait';
  delayDays: number;
  subject?: string;
  body?: string;
}

interface Sequence {
  sequenceId: string;
  name: string;
  description?: string;
  steps: SequenceStep[];
  exitOnReply: boolean;
  enrolledCount: number;
  completedCount: number;
  exitedCount: number;
  createdAt: string;
}

interface Enrollment {
  enrollmentId: string;
  prospectEmail: string;
  prospectName?: string;
  prospectCompany?: string;
  status: string;
  currentStepIndex: number;
  nextRunAt: string;
}

const STATUS_TONE: Record<string, string> = {
  running: 'text-blue-500 bg-blue-500/10',
  completed: 'text-emerald-500 bg-emerald-500/10',
  exited: 'text-amber-500 bg-amber-500/10',
  paused: 'text-muted-foreground bg-muted',
  failed: 'text-red-500 bg-red-500/10',
};

function stepLabel(step: SequenceStep): string {
  if (step.type === 'wait') return `Wait ${step.delayDays} day${step.delayDays === 1 ? '' : 's'}`;
  const channel = step.type.replace('send_', '');
  return step.subject ? `${channel}: ${step.subject}` : `Send ${channel}`;
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<Record<string, Enrollment[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ sequences: Sequence[] }>('/api/sequences');
      setSequences(data.sequences ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sequences.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (sequenceId: string) => {
    if (expanded === sequenceId) {
      setExpanded(null);
      return;
    }
    setExpanded(sequenceId);
    // Fetched on demand and cached — most sequences are never expanded.
    if (!enrollments[sequenceId]) {
      try {
        const data = await api.get<{ enrollments: Enrollment[] }>(
          `/api/sequences/${encodeURIComponent(sequenceId)}/enrollments`,
        );
        setEnrollments((prev) => ({ ...prev, [sequenceId]: data.enrollments ?? [] }));
      } catch {
        setEnrollments((prev) => ({ ...prev, [sequenceId]: [] }));
      }
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Multi-touch outreach, advanced by a server cron every five minutes.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <ArrowClockwise size={16} className={cn(loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
        <Warning size={18} className="mt-0.5 shrink-0 text-amber-500" />
        <div>
          <span className="font-medium">Email delivery is not configured.</span>{' '}
          <span className="text-muted-foreground">
            With <code className="rounded bg-muted px-1">EMAIL_SENDER=log</code> steps are recorded
            to the enrollment history and logged, never delivered. That is the default so sequences
            can be exercised without reaching real inboxes.
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader />
        </div>
      ) : sequences.length === 0 ? (
        <div className="rounded-card border border-dashed border-border py-16 text-center">
          <PaperPlaneTilt size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">No sequences yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one to start a multi-touch outreach cadence.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq) => {
            const open = expanded === seq.sequenceId;
            const rows = enrollments[seq.sequenceId];
            return (
              <div key={seq.sequenceId} className="rounded-card border border-border bg-card">
                <button
                  type="button"
                  onClick={() => void toggle(seq.sequenceId)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  {open ? <CaretDown size={16} /> : <CaretRight size={16} />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{seq.name}</div>
                    {seq.description && (
                      <div className="truncate text-sm text-muted-foreground">{seq.description}</div>
                    )}
                  </div>
                  <div className="hidden gap-4 text-xs text-muted-foreground sm:flex">
                    <span>{seq.steps.length} steps</span>
                    <span>{seq.enrolledCount} enrolled</span>
                    <span>{seq.completedCount} completed</span>
                  </div>
                </button>

                {open && (
                  <div className="space-y-4 border-t border-border px-4 py-3">
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Steps
                      </div>
                      <ol className="space-y-1">
                        {seq.steps.map((step, i) => (
                          <li key={step.id} className="flex items-center gap-2 text-sm">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px]">
                              {i + 1}
                            </span>
                            {step.type === 'wait' ? (
                              <Clock size={14} className="text-muted-foreground" />
                            ) : (
                              <EnvelopeSimple size={14} className="text-primary" />
                            )}
                            <span className="truncate">{stepLabel(step)}</span>
                          </li>
                        ))}
                      </ol>
                    </div>

                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Enrollments
                      </div>
                      {!rows ? (
                        <div className="py-2 text-sm text-muted-foreground">Loading…</div>
                      ) : rows.length === 0 ? (
                        <div className="py-2 text-sm text-muted-foreground">Nobody enrolled yet.</div>
                      ) : (
                        <div className="space-y-1">
                          {rows.map((e) => (
                            <div
                              key={e.enrollmentId}
                              className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2 text-sm"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {e.prospectName ?? e.prospectEmail}
                                {e.prospectCompany && (
                                  <span className="text-muted-foreground"> · {e.prospectCompany}</span>
                                )}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                step {e.currentStepIndex + 1}
                              </span>
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                  STATUS_TONE[e.status] ?? 'bg-muted text-muted-foreground',
                                )}
                              >
                                {e.status}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
