'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MagnifyingGlass, Sparkle, X, CheckCircle, Lightning, Buildings,
  EnvelopeSimple, LinkedinLogo, Phone, Warning,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/providers/ThemeProvider';
import { LeadSearchProgress } from './LeadSearchProgress';
import { ApiError } from '@/lib/api-client';
import { findLeadsApi, prospectsApi, type FindLeadsJob } from '@/lib/prospects-api';

/**
 * AI lead finder.
 *
 * Starts an eight-phase pipeline run on the server and polls for progress.
 * The run is asynchronous because it takes one to three minutes — longer than
 * the platform's request timeout — so the browser never holds the connection
 * open waiting for it.
 *
 * Partial results arrive from phase four onward, which is why the progress
 * view shows lead cards filling in rather than a spinner.
 */

const INDUSTRIES = [
  'Technology / SaaS', 'Healthcare', 'Financial Services', 'Manufacturing',
  'Retail / E-commerce', 'Professional Services', 'Education', 'Real Estate',
];

const SOURCES = [
  { key: 'google', label: 'Web search', always: true },
  { key: 'crunchbase', label: 'Crunchbase' },
  { key: 'github', label: 'GitHub' },
  { key: 'apollo', label: 'Apollo' },
] as const;

interface ExtractedLead {
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  website?: string;
  /** Resolved by the pipeline in phase 7 when the lead has no website. */
  companyDomain?: string;
  location?: string;
  score?: number;
  confidence?: string;
  seniority?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (count: number) => void;
}

export function FindLeadsModal({ open, onClose, onImported }: Props) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [mode, setMode] = useState<'ai' | 'filters'>('ai');
  const [prompt, setPrompt] = useState('');
  const [jobTitles, setJobTitles] = useState('');
  const [industries, setIndustries] = useState<string[]>([]);
  const [locations, setLocations] = useState('');
  const [depth, setDepth] = useState<'quick' | 'deep'>('quick');
  const [sources, setSources] = useState<string[]>(['google']);

  // Campaign name, stamped onto every imported lead as a tag.
  //
  // A prospecting run is rarely one search — it is eight or ten across
  // regions and personas, often spread over days. Without a label they all
  // land in one undifferentiated list, and a later campaign is
  // indistinguishable from this one. Remembered between runs because
  // retyping it identically on every search is how the labelling silently
  // stops happening.
  const [campaign, setCampaign] = useState('');
  useEffect(() => {
    try {
      const last = localStorage.getItem('lastCampaign');
      if (last) setCampaign(last);
    } catch {
      // Private windows and blocked site data throw on access; the field
      // simply starts empty.
    }
  }, []);

  const [job, setJob] = useState<FindLeadsJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [leads, setLeads] = useState<ExtractedLead[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
  }, []);

  // Timers outlive the component if the user closes mid-run, so tear them
  // down on unmount as well as on completion.
  useEffect(() => stopTimers, [stopTimers]);

  const reset = () => {
    stopTimers();
    setJob(null);
    setJobId(null);
    setLeads([]);
    setSelected(new Set());
    setElapsed(0);
    setError(null);
  };

  const start = async () => {
    setError(null);
    if (mode === 'ai' && !prompt.trim()) {
      setError('Describe who you are looking for.');
      return;
    }
    if (mode === 'filters' && !jobTitles.trim() && industries.length === 0 && !locations.trim()) {
      setError('Set at least one filter.');
      return;
    }

    try {
      const { jobId: id } = await findLeadsApi.start({
        mode,
        ...(mode === 'ai'
          ? { prompt: prompt.trim() }
          : { jobTitles: jobTitles.trim(), industries, locations: locations.trim() }),
        searchDepth: depth,
        sources,
      });
      setJobId(id);
      setElapsed(0);
      setJob({
        jobId: id, status: 'queued', phase: 0, phaseLabel: 'Getting ready…',
        percentComplete: 0, partialLeads: [], searchesRun: [],
        estimatedSeconds: depth === 'deep' ? 150 : 60,
      });

      tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      pollRef.current = setInterval(() => void poll(id), 1500);
      void poll(id);
    } catch (err) {
      // 402 means out of credits — worth saying so rather than "search failed".
      setError(
        err instanceof ApiError
          ? err.isCreditExhausted
            ? 'You are out of credits for lead searches.'
            : err.message
          : 'Could not start the search.',
      );
    }
  };

  const poll = async (id: string) => {
    try {
      const { job: current } = await findLeadsApi.poll(id);
      setJob(current);
      if (current.partialLeads?.length) {
        setLeads(current.partialLeads as unknown as ExtractedLead[]);
      }

      if (current.status !== 'running' && current.status !== 'queued') {
        stopTimers();
        if (current.status === 'failed') {
          setError(current.errorMessage ?? 'The search could not be completed.');
        }
        if (current.status === 'completed') {
          // Pre-select everything — the common case is wanting the whole list,
          // and deselecting a few is less work than selecting thirty.
          setSelected(new Set((current.partialLeads ?? []).map((_, i) => i)));
        }
      }
    } catch {
      stopTimers();
      setError('Lost contact with the search. It may still be running.');
    }
  };

  const cancel = async () => {
    stopTimers();
    if (jobId) await findLeadsApi.cancel(jobId).catch(() => {});
    reset();
  };

  const importSelected = async () => {
    const chosen = [...selected].map((i) => leads[i]).filter(Boolean);
    if (chosen.length === 0) return;

    setImporting(true);
    setError(null);
    try {
      const result = await prospectsApi.import(
        chosen.map((l) => ({
          name: l.name,
          email: l.email || undefined,
          phone: l.phone || undefined,
          company: l.company || undefined,
          title: l.title || undefined,
          linkedinUrl: l.linkedinUrl || undefined,
          // A resolved company domain is the lead's website for every
          // practical purpose here, and it is what unlocks email patterns.
          // It used to be dropped: the runner stores it on companyDomain and
          // this payload only ever mapped `website`.
          website: l.website || (l.companyDomain ? 'https://' + l.companyDomain : undefined),
          // The pipeline's score reflects match quality against the search,
          // which the field heuristic cannot capture, so it is carried over.
          score: l.score,
          source: 'import',
          ...(campaign.trim() ? { tags: [campaign.trim()] } : {}),
        })),
      );

      if (campaign.trim()) {
        try {
          localStorage.setItem('lastCampaign', campaign.trim());
        } catch {
          // Not worth failing an import that already succeeded.
        }
      }
      onImported(result.created);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import the selected leads.');
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

  const running = job?.status === 'running' || job?.status === 'queued';
  const done = job?.status === 'completed';
  const stalled = running && elapsed > (job?.estimatedSeconds ?? 60) * 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-border bg-card shadow-xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkle size={20} className="text-primary" weight="duotone" />
            <h2 className="font-heading font-semibold">Find leads</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              if (running) void cancel();
              else {
                reset();
                onClose();
              }
            }}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {!job && (
            <div className="space-y-5">
              <div className="flex gap-2">
                {(['ai', 'filters'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn(
                      'flex-1 rounded-lg border px-4 py-3 text-left transition-colors',
                      mode === m ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground',
                    )}
                  >
                    <div className="text-sm font-medium">
                      {m === 'ai' ? 'Describe it' : 'Use filters'}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {m === 'ai' ? 'Plain English, we build the queries' : 'Titles, industries, locations'}
                    </div>
                  </button>
                ))}
              </div>

              {mode === 'ai' ? (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Who are you looking for?</label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    placeholder="Heads of sales at seed-stage fintech companies in Bangalore"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
                  />
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Job titles</label>
                    <input
                      value={jobTitles}
                      onChange={(e) => setJobTitles(e.target.value)}
                      placeholder="VP of Sales, Head of Growth"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Industries</label>
                    <div className="flex flex-wrap gap-2">
                      {INDUSTRIES.map((ind) => (
                        <button
                          key={ind}
                          type="button"
                          onClick={() =>
                            setIndustries((p) =>
                              p.includes(ind) ? p.filter((i) => i !== ind) : [...p, ind],
                            )
                          }
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs transition-colors',
                            industries.includes(ind)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {ind}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Locations</label>
                    <input
                      value={locations}
                      onChange={(e) => setLocations(e.target.value)}
                      placeholder="Bangalore, Berlin"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-sm font-medium">Depth</label>
                <div className="flex gap-2">
                  {(['quick', 'deep'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDepth(d)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2 text-left transition-colors',
                        depth === d ? 'border-primary bg-primary/5' : 'border-border',
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-sm font-medium capitalize">
                        {d === 'quick' ? <Lightning size={14} /> : <Buildings size={14} />}
                        {d}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {d === 'quick' ? 'Up to 30 leads, about a minute' : 'Up to 60, plus company signals'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">Sources</label>
                <div className="flex flex-wrap gap-2">
                  {SOURCES.map((source) => {
                    const on = sources.includes(source.key);
                    // Web search is the pipeline's backbone — phases 2 and 3
                    // have nothing to read without it — so it cannot be turned off.
                    const locked = 'always' in source && source.always === true;
                    return (
                      <button
                        key={source.key}
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          setSources((p) =>
                            p.includes(source.key)
                              ? p.filter((s) => s !== source.key)
                              : [...p, source.key],
                          )
                        }
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                          on
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:text-foreground',
                          locked && 'cursor-default opacity-80',
                        )}
                      >
                        {source.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Sources without an API key configured are skipped automatically.
                </p>
              </div>

              <div>
                <label htmlFor="campaign" className="mb-1.5 block text-sm font-medium">
                  Campaign <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="campaign"
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  placeholder="e.g. sydney-hospitality"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors',
                    'focus:border-primary focus:ring-1 focus:ring-primary',
                    isDark ? 'border-white/10 bg-white/5' : 'border-black/10 bg-white',
                  )}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Tags every lead you import, so this campaign stays separable from the rest
                  of your list. Reused for your next search.
                </p>
              </div>
            </div>
          )}

          {running && job && (
            <LeadSearchProgress
              isDark={isDark}
              phase={job.phase}
              phaseLabel={job.phaseLabel}
              percentComplete={job.percentComplete}
              estimatedSeconds={job.estimatedSeconds}
              elapsedSeconds={elapsed}
              searchesRun={job.searchesRun ?? []}
              partialLeads={leads}
              stalled={stalled}
              onCancel={() => void cancel()}
            />
          )}

          {done && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium">{leads.length} leads found</span>
                  {job?.summary && (
                    <span className="ml-2 text-muted-foreground">{job.summary}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) =>
                      prev.size === leads.length ? new Set() : new Set(leads.map((_, i) => i)),
                    )
                  }
                  className="text-xs text-primary hover:underline"
                >
                  {selected.size === leads.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              {leads.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                  No leads matched. Try a broader description or more sources.
                </div>
              ) : (
                leads.map((lead, i) => (
                  <label
                    key={`${lead.name}-${i}`}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      selected.has(i) ? 'border-primary/50 bg-primary/5' : 'border-border',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          next.has(i) ? next.delete(i) : next.add(i);
                          return next;
                        })
                      }
                      className="h-4 w-4 accent-[var(--color-primary)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{lead.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        {lead.title && <span className="truncate">{lead.title}</span>}
                        {lead.company && <span className="truncate">{lead.company}</span>}
                        {lead.email && (
                          <span className="inline-flex items-center gap-1 truncate">
                            <EnvelopeSimple size={11} />
                            {lead.email}
                          </span>
                        )}
                        {lead.phone && (
                          <span className="inline-flex items-center gap-1">
                            <Phone size={11} />
                            {lead.phone}
                          </span>
                        )}
                        {lead.linkedinUrl && <LinkedinLogo size={11} />}
                      </div>
                    </div>
                    {typeof lead.score === 'number' && (
                      <span className="shrink-0 text-sm font-semibold tabular-nums">{lead.score}</span>
                    )}
                  </label>
                ))
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <Warning size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-4">
          <span className="text-xs text-muted-foreground">
            {done ? `${selected.size} of ${leads.length} selected` : ''}
          </span>
          <div className="flex gap-2">
            {job && !running && (
              <Button variant="ghost" onClick={reset}>
                New search
              </Button>
            )}
            {!job && (
              <Button onClick={() => void start()}>
                <MagnifyingGlass size={16} />
                Search
              </Button>
            )}
            {done && leads.length > 0 && (
              <Button onClick={() => void importSelected()} disabled={importing || selected.size === 0}>
                <CheckCircle size={16} />
                {importing ? 'Importing…' : `Import ${selected.size}`}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
