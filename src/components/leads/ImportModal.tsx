'use client';

import { useEffect, useRef, useState } from 'react';
import {
  UploadSimple, X, CheckCircle, Warning, FileCsv, LinkedinLogo, DownloadSimple,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { prospectsApi } from '@/lib/prospects-api';
import { downloadFile } from '@/lib/csv';
import {
  generateCSVTemplate,
  parseLinkedInUrls,
  parseProspectsFromFile,
  type ProspectData,
} from '@/lib/prospect-import-export';

/**
 * Bulk import.
 *
 * Small batches complete inline; anything over fifty rows runs in the
 * background and reports progress over server-sent events. The progress
 * source is the batch row in the database rather than an in-memory emitter,
 * because with more than one instance the browser opening the stream will
 * often reach a different one than is doing the importing.
 */

type Step = 'input' | 'preview' | 'progress' | 'done';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (count: number) => void;
}

interface Progress {
  status: string;
  imported: number;
  skipped: number;
  duplicates: number;
  totalRows: number;
  progress?: { phase?: string; processed?: number; total?: number } | null;
}

export function ImportModal({ open, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [tab, setTab] = useState<'file' | 'linkedin'>('file');
  const [rows, setRows] = useState<ProspectData[]>([]);
  const [filename, setFilename] = useState<string>();
  const [linkedinText, setLinkedinText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  // Shares the remembered campaign with the find-leads modal, so a CSV
  // dropped in mid-campaign lands under the same label as the searches.
  const [campaign, setCampaign] = useState('');
  useEffect(() => {
    try {
      const last = localStorage.getItem('lastCampaign');
      if (last) setCampaign(last);
    } catch {
      // Storage can be unavailable; the field just starts empty.
    }
  }, []);
  const [result, setResult] = useState<{ created: number; errors: string[]; duplicates: string[] } | null>(null);

  const streamRef = useRef<EventSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // An EventSource left open keeps a connection alive after the modal closes.
  useEffect(() => {
    return () => streamRef.current?.close();
  }, []);

  const reset = () => {
    streamRef.current?.close();
    streamRef.current = null;
    setStep('input');
    setRows([]);
    setFilename(undefined);
    setLinkedinText('');
    setError(null);
    setProgress(null);
    setResult(null);
  };

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const parsed = await parseProspectsFromFile(file);
      if (parsed.length === 0) {
        setError('No usable rows found. Check the file has a header row with a "name" column.');
        return;
      }
      setRows(parsed);
      setFilename(file.name);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    }
  };

  const handleLinkedin = () => {
    setError(null);
    const parsed = parseLinkedInUrls(linkedinText);
    if (parsed.length === 0) {
      setError('No LinkedIn profile URLs found.');
      return;
    }
    setRows(parsed);
    setFilename('linkedin-urls');
    setStep('preview');
  };

  const startImport = async () => {
    setError(null);
    setStep('progress');
    try {
      const tag = campaign.trim();
      const res = await prospectsApi.import(
        rows.map((r) => ({ ...r, name: r.name, ...(tag ? { tags: [tag] } : {}) })),
        filename,
      );
      if (tag) {
        try {
          localStorage.setItem('lastCampaign', tag);
        } catch {
          // Ignored — an import that worked must not fail on a stored preference.
        }
      }

      // The inline path returns totals directly; the background path returns
      // a batch id and a 'running' status to follow.
      if (res.status === 'running' && res.batchId) {
        followStream(res.batchId);
        return;
      }

      setResult({ created: res.created, errors: res.errors ?? [], duplicates: res.duplicates ?? [] });
      setStep('done');
      onImported(res.created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed.');
      setStep('preview');
    }
  };

  const followStream = (batchId: string) => {
    const source = new EventSource(`/api/prospects/import/${encodeURIComponent(batchId)}/stream`);
    streamRef.current = source;

    source.addEventListener('progress', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as Progress;
      setProgress(data);
      if (data.status !== 'running') {
        source.close();
        setResult({ created: data.imported, errors: [], duplicates: [] });
        setStep('done');
        onImported(data.imported);
      }
    });

    source.addEventListener('end', () => source.close());
    source.onerror = () => {
      source.close();
      // The import itself keeps going server-side — only the live view is lost.
      setError('Lost the live progress feed. The import is still running; reopen history to check.');
      setStep('done');
    };
  };

  if (!open) return null;

  const pct = progress?.progress?.total
    ? Math.round(((progress.progress.processed ?? 0) / progress.progress.total) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-card shadow-xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <UploadSimple size={20} className="text-primary" />
            <h2 className="font-heading font-semibold">Import prospects</h2>
          </div>
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {step === 'input' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                {([['file', 'File', FileCsv], ['linkedin', 'LinkedIn URLs', LinkedinLogo]] as const).map(
                  ([key, label, Icon]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab(key)}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors',
                        tab === key ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground',
                      )}
                    >
                      <Icon size={16} />
                      {label}
                    </button>
                  ),
                )}
              </div>

              {tab === 'file' ? (
                <>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="flex w-full flex-col items-center gap-2 rounded-card border border-dashed border-border py-12 transition-colors hover:border-primary"
                  >
                    <UploadSimple size={28} className="text-muted-foreground" />
                    <span className="text-sm font-medium">Choose a CSV or JSON file</span>
                    <span className="text-xs text-muted-foreground">
                      Needs a header row including <code>name</code>
                    </span>
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFile(file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => downloadFile(generateCSVTemplate(), 'prospects-template.csv', 'text/csv')}
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <DownloadSimple size={14} />
                    Download a template
                  </button>
                </>
              ) : (
                <>
                  <textarea
                    value={linkedinText}
                    onChange={(e) => setLinkedinText(e.target.value)}
                    rows={8}
                    placeholder={'https://www.linkedin.com/in/jane-doe\nhttps://www.linkedin.com/in/john-smith'}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  />
                  <Button onClick={handleLinkedin} disabled={!linkedinText.trim()}>
                    Parse URLs
                  </Button>
                </>
              )}
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-3">
              <p className="text-sm">
                <span className="font-medium">{rows.length} rows</span> ready from{' '}
                <span className="text-muted-foreground">{filename}</span>. Duplicates are detected
                against your existing prospects and within the file itself.
              </p>
              <div>
                <label htmlFor="import-campaign" className="mb-1.5 block text-sm font-medium">
                  Campaign <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="import-campaign"
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  placeholder="e.g. sydney-hospitality"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Company</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="truncate px-3 py-1.5">{r.name || <em className="text-destructive">missing</em>}</td>
                        <td className="truncate px-3 py-1.5 text-muted-foreground">{r.email ?? '—'}</td>
                        <td className="truncate px-3 py-1.5 text-muted-foreground">{r.company ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 50 && (
                <p className="text-xs text-muted-foreground">Showing the first 50 of {rows.length}.</p>
              )}
            </div>
          )}

          {step === 'progress' && (
            <div className="space-y-4 py-8 text-center">
              <div className="text-sm font-medium">Importing…</div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${Math.max(pct, 5)}%` }}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {progress
                  ? `${progress.progress?.processed ?? 0} of ${progress.progress?.total ?? progress.totalRows} processed`
                  : 'Starting…'}
              </div>
            </div>
          )}

          {step === 'done' && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-500">
                <CheckCircle size={20} weight="fill" />
                <span className="font-medium">Imported {result.created} prospects</span>
              </div>
              {result.duplicates.length > 0 && (
                <div>
                  <div className="mb-1 text-sm font-medium">
                    {result.duplicates.length} skipped as duplicates
                  </div>
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {result.duplicates.slice(0, 20).map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              )}
              {result.errors.length > 0 && (
                <div>
                  <div className="mb-1 text-sm font-medium text-destructive">
                    {result.errors.length} rows failed
                  </div>
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Imports can be undone from history within 24 hours.
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <Warning size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4">
          {step === 'preview' && (
            <>
              <Button variant="ghost" onClick={reset}>Back</Button>
              <Button onClick={() => void startImport()}>Import {rows.length}</Button>
            </>
          )}
          {step === 'done' && (
            <>
              <Button variant="ghost" onClick={reset}>Import more</Button>
              <Button onClick={() => { reset(); onClose(); }}>Done</Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
