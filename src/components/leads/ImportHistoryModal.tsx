'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClockCounterClockwise, X, ArrowUUpLeft, Warning, CheckCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { ApiError } from '@/lib/api-client';
import { prospectsApi } from '@/lib/prospects-api';

/**
 * Import history, with undo.
 *
 * Undo deletes every prospect that came from a batch — one statement, because
 * prospects carry the batch id as a foreign key. It reverses the import as an
 * event, so a prospect edited since the import is still removed; leaving it
 * behind would strand a row that no longer belongs to any batch.
 *
 * The window is 24 hours, enforced server-side.
 */

interface Batch {
  batchId: string;
  timestamp: string;
  filename?: string;
  importedCount: number;
  failedCount: number;
  skippedCount: number;
  status: string;
  undone: boolean;
  canUndo: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onUndone: (deleted: number) => void;
}

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ImportHistoryModal({ open, onClose, onUndone }: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await prospectsApi.importHistory();
      setBatches(data.history ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load import history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const undo = async (batchId: string) => {
    setUndoing(batchId);
    setError(null);
    try {
      const result = await prospectsApi.undoImport(batchId);
      onUndone(result.deleted);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not undo that import.');
    } finally {
      setUndoing(null);
      setConfirming(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-card shadow-xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <ClockCounterClockwise size={20} className="text-primary" />
            <h2 className="font-heading font-semibold">Import history</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <Warning size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <Loader />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No imports yet.
            </div>
          ) : (
            <div className="space-y-2">
              {batches.map((b) => (
                <div
                  key={b.batchId}
                  className={cn(
                    'rounded-lg border border-border px-4 py-3',
                    b.undone && 'opacity-60',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {b.filename ?? 'Untitled import'}
                        {b.undone && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                            undone
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{when(b.timestamp)}</span>
                        <span>{b.importedCount} imported</span>
                        {b.skippedCount > 0 && <span>{b.skippedCount} duplicates</span>}
                        {b.failedCount > 0 && <span>{b.failedCount} failed</span>}
                      </div>
                    </div>

                    {confirming === b.batchId ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Delete {b.importedCount}?
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          No
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={undoing === b.batchId}
                          onClick={() => void undo(b.batchId)}
                        >
                          {undoing === b.batchId ? 'Undoing…' : 'Yes, undo'}
                        </Button>
                      </div>
                    ) : b.canUndo ? (
                      // Two-step, because this deletes rows and the count is
                      // not obvious from the button alone.
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirming(b.batchId)}
                        className="shrink-0"
                      >
                        <ArrowUUpLeft size={14} />
                        Undo
                      </Button>
                    ) : b.undone ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <CheckCircle size={14} className="mr-1 inline" />
                        reversed
                      </span>
                    ) : (
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        title="Imports can only be undone within 24 hours"
                      >
                        window closed
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
