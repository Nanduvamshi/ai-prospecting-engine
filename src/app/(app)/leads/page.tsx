'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Target, MagnifyingGlass, Sparkle, CheckCircle, UserPlus, Clock, X, Trash,
  EnvelopeSimple, Phone, LinkedinLogo, Globe, Buildings, Lightning,
  ArrowClockwise, Funnel, UploadSimple, ClockCounterClockwise,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { useTheme } from '@/components/providers/ThemeProvider';
import { usePermissions } from '@/hooks/usePermissions';
import { ApiError } from '@/lib/api-client';
import { prospectsApi, type Campaign, type Prospect, type ProspectStatus } from '@/lib/prospects-api';
import { FindLeadsModal } from '@/components/leads/FindLeadsModal';
import { ImportModal } from '@/components/leads/ImportModal';
import { ImportHistoryModal } from '@/components/leads/ImportHistoryModal';

const STATUS = {
  new: { label: 'New', icon: Sparkle, tone: 'text-blue-500 bg-blue-500/10' },
  researching: { label: 'Researching', icon: MagnifyingGlass, tone: 'text-purple-500 bg-purple-500/10' },
  qualified: { label: 'Qualified', icon: CheckCircle, tone: 'text-green-500 bg-green-500/10' },
  contacted: { label: 'Contacted', icon: EnvelopeSimple, tone: 'text-amber-500 bg-amber-500/10' },
  converted: { label: 'Converted', icon: UserPlus, tone: 'text-emerald-500 bg-emerald-500/10' },
  disqualified: { label: 'Disqualified', icon: X, tone: 'text-red-500 bg-red-500/10' },
} as const satisfies Record<ProspectStatus, { label: string; icon: typeof Sparkle; tone: string }>;

const SOURCE_ICON = {
  linkedin: LinkedinLogo, website: Globe, referral: UserPlus,
  event: Buildings, manual: Target, import: Lightning,
} as const;

function scoreTone(score: number): string {
  if (score >= 70) return 'text-emerald-500';
  if (score >= 40) return 'text-amber-500';
  return 'text-muted-foreground';
}

export default function LeadsPage() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { can, loaded: permsLoaded } = usePermissions();

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProspectStatus | 'all'>('all');
  const [campaignFilter, setCampaignFilter] = useState<string>('all');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Guards against a slow first request landing after a faster later one and
  // overwriting it — easy to hit when typing in the search box.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (opts: { append?: boolean; cursor?: string | null } = {}) => {
      const seq = ++requestSeq.current;
      opts.append ? setLoadingMore(true) : setLoading(true);
      setError(null);

      try {
        const data = await prospectsApi.list({
          status: statusFilter === 'all' ? undefined : [statusFilter],
          search: search.trim() || undefined,
          tag: campaignFilter === 'all' ? undefined : campaignFilter,
          limit: 25,
          cursor: opts.cursor ?? undefined,
          stats: !opts.append,
        });

        if (seq !== requestSeq.current) return; // a newer request already won

        setProspects((prev) => (opts.append ? [...prev, ...data.prospects] : data.prospects));
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
        if (data.stats) setStats(data.stats);
        // Campaigns ride along with stats, so the selector reflects whatever
        // exists right now without a second round trip.
        if (data.campaigns) setCampaigns(data.campaigns);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof ApiError ? err.message : 'Could not load prospects.');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [statusFilter, search, campaignFilter],
  );

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleConvert = async (prospect: Prospect) => {
    setBusyId(prospect.prospectId);
    setError(null);
    try {
      await prospectsApi.convert(prospect.prospectId);
      // Reflect locally rather than refetching the page — the server already
      // told us it succeeded, and a refetch would lose scroll position.
      setProspects((prev) =>
        prev.map((p) =>
          p.prospectId === prospect.prospectId ? { ...p, status: 'converted' as const } : p,
        ),
      );
      setStats((s) => ({
        ...s,
        [prospect.status]: Math.max(0, (s[prospect.status] ?? 1) - 1),
        converted: (s.converted ?? 0) + 1,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not convert this prospect.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (prospect: Prospect) => {
    setBusyId(prospect.prospectId);
    try {
      await prospectsApi.remove(prospect.prospectId);
      setProspects((prev) => prev.filter((p) => p.prospectId !== prospect.prospectId));
      setStats((s) => ({
        ...s,
        total: Math.max(0, (s.total ?? 1) - 1),
        [prospect.status]: Math.max(0, (s[prospect.status] ?? 1) - 1),
      }));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(prospect.prospectId);
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete this prospect.');
    } finally {
      setBusyId(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setError(null);
    try {
      await prospectsApi.bulkDelete(ids);
      setProspects((prev) => prev.filter((p) => !selected.has(p.prospectId)));
      setSelected(new Set());
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the selected prospects.');
    }
  };

  const statCards = useMemo(
    () => [
      { key: 'total', label: 'Total', value: stats.total ?? 0 },
      { key: 'new', label: 'New', value: stats.new ?? 0 },
      { key: 'qualified', label: 'Qualified', value: stats.qualified ?? 0 },
      { key: 'converted', label: 'Converted', value: stats.converted ?? 0 },
    ],
    [stats],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Discover, qualify and convert prospects.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <ArrowClockwise size={16} className={cn(loading && 'animate-spin')} />
            Refresh
          </Button>
          {permsLoaded && can('prospects:create') && (
            <>
              <Button
                variant="ghost"
                onClick={() => setHistoryOpen(true)}
                title="Import history"
                aria-label="Import history"
              >
                <ClockCounterClockwise size={16} />
              </Button>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <UploadSimple size={16} />
                Import
              </Button>
              <Button onClick={() => setFindOpen(true)}>
                <Sparkle size={16} weight="duotone" />
                Find leads
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statCards.map((card) => (
          <div key={card.key} className="rounded-card border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <MagnifyingGlass
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, company or title"
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto">
          <Funnel size={16} className="mr-1 shrink-0 text-muted-foreground" />
          {(['all', ...Object.keys(STATUS)] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key as ProspectStatus | 'all')}
              className={cn(
                'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                statusFilter === key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {key === 'all' ? 'All' : STATUS[key as ProspectStatus].label}
            </button>
          ))}
        </div>

        {/* Only rendered once something is tagged — an empty selector on a
            single-campaign list is noise. */}
        {campaigns.length > 0 && (
          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            aria-label="Filter by campaign"
            className="shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          >
            <option value="all">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-2">
          <span className="text-sm">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            {can('prospects:delete') && (
              <Button variant="destructive" onClick={() => void handleBulkDelete()}>
                <Trash size={16} />
                Delete
              </Button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader />
        </div>
      ) : prospects.length === 0 ? (
        <div className="rounded-card border border-dashed border-border py-16 text-center">
          <Target size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">No prospects found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {search || statusFilter !== 'all'
              ? 'Try clearing your filters.'
              : 'Run a search or import a list to get started.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {prospects.map((p) => {
            const status = STATUS[p.status];
            const StatusIcon = status.icon;
            const SourceIcon = SOURCE_ICON[p.source] ?? Target;
            const busy = busyId === p.prospectId;

            return (
              <div
                key={p.prospectId}
                className={cn(
                  'flex items-center gap-4 rounded-card border border-border bg-card px-4 py-3 transition-colors',
                  selected.has(p.prospectId) && 'border-primary/50 bg-primary/5',
                  busy && 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.prospectId)}
                  onChange={() => toggle(p.prospectId)}
                  aria-label={`Select ${p.name}`}
                  className="h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                />

                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                  {p.name.charAt(0).toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', status.tone)}>
                      <StatusIcon size={11} className="mr-1 inline" />
                      {status.label}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {p.title && <span className="truncate">{p.title}</span>}
                    {p.company && <span className="truncate">{p.company}</span>}
                    {p.email && (
                      <span className="inline-flex items-center gap-1 truncate">
                        <EnvelopeSimple size={12} />
                        {p.email}
                      </span>
                    )}
                    {p.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone size={12} />
                        {p.phone}
                      </span>
                    )}
                  </div>
                </div>

                <div className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <SourceIcon size={14} />
                  {p.source}
                </div>

                <div className={cn('shrink-0 text-sm font-semibold tabular-nums', scoreTone(p.score))}>
                  {p.score}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {p.status !== 'converted' && p.email && can('prospects:edit') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleConvert(p)}
                      title="Convert to contact"
                    >
                      <UserPlus size={16} />
                    </Button>
                  )}
                  {can('prospects:delete') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleDelete(p)}
                      title="Delete"
                    >
                      <Trash size={16} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={() => void load({ append: true, cursor })}
              >
                {loadingMore ? <Clock size={16} className="animate-spin" /> : null}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <FindLeadsModal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        onImported={(n) => {
          setToast(`Imported ${n} prospect${n === 1 ? '' : 's'}`);
          void load();
        }}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(n) => {
          setToast(`Imported ${n} prospect${n === 1 ? '' : 's'}`);
          void load();
        }}
      />

      <ImportHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onUndone={(n) => {
          setToast(`Removed ${n} imported prospect${n === 1 ? '' : 's'}`);
          void load();
        }}
      />

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-card px-4 py-3 text-sm shadow-lg">
          <CheckCircle size={18} weight="fill" className="text-emerald-500" />
          {toast}
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-2 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
