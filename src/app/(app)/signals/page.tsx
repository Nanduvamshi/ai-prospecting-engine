'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChartLineUp, CurrencyDollar, Star, Globe, ChatCircleDots, ArrowClockwise, ArrowSquareOut,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { api, ApiError } from '@/lib/api-client';

/**
 * Intent signals.
 *
 * Reads what the scheduled sweeps have collected — funding announcements,
 * negative reviews with switching intent, newly registered domains matching
 * ICP keywords, and buying-intent chatter on Reddit and Hacker News. The
 * sweeps run on a cron and persist to a rolling fourteen-day window; this is
 * the read side of that.
 */

const TYPES = [
  { key: 'funding', label: 'Funding', icon: CurrencyDollar, hint: 'Fresh rounds — budget just arrived' },
  { key: 'review', label: 'Reviews', icon: Star, hint: 'Low ratings on competitors' },
  { key: 'domain', label: 'New domains', icon: Globe, hint: 'Recently registered, ICP keywords' },
  { key: 'social', label: 'Social', icon: ChatCircleDots, hint: 'People asking for recommendations' },
] as const;

type SignalType = (typeof TYPES)[number]['key'];

interface SweepItem {
  payload: Record<string, unknown>;
  ingestedAt: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Sweep payloads differ per source, so pick out something readable. */
function describe(type: SignalType, payload: Record<string, unknown>) {
  const s = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined);
  switch (type) {
    case 'funding':
      return {
        title: s('company') ?? 'Unknown company',
        detail: [s('round'), s('amount')].filter(Boolean).join(' · ') || 'Funding announced',
        url: s('url'),
      };
    case 'review':
      return {
        title: s('company') ?? 'Unknown company',
        detail: `${payload.rating ?? '?'}★ on ${s('source') ?? 'review site'} — ${s('quote') ?? ''}`,
        url: s('url'),
      };
    case 'domain':
      return {
        title: s('domain') ?? 'Unknown domain',
        detail: s('registeredAt') ? `Registered ${timeAgo(s('registeredAt')!)}` : 'Newly registered',
        url: s('domain') ? `https://${s('domain')}` : undefined,
      };
    case 'social':
      return {
        title: s('title') ?? 'Discussion',
        detail: `on ${s('platform') ?? 'social'}`,
        url: s('url'),
      };
  }
}

export default function SignalsPage() {
  const [active, setActive] = useState<SignalType>('funding');
  const [items, setItems] = useState<SweepItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (type: SignalType) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: SweepItem[]; count: number }>(
        `/api/signals/recent?type=${type}&limit=50`,
      );
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load signals.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  const activeMeta = TYPES.find((t) => t.key === active)!;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Signals</h1>
          <p className="text-sm text-muted-foreground">
            Buying intent picked up by the scheduled sweeps.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load(active)} disabled={loading}>
          <ArrowClockwise size={16} className={cn(loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        {TYPES.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActive(key)}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
              active === key
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{activeMeta.hint}</p>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border py-16 text-center">
          <ChartLineUp size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">No {activeMeta.label.toLowerCase()} signals yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Sweeps run on a schedule and keep a rolling fourteen-day window. Trigger one manually
            with <code className="rounded bg-muted px-1">POST /api/cron/{active}-sweep</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => {
            const info = describe(active, item.payload);
            return (
              <div
                key={`${info.title}-${i}`}
                className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3"
              >
                <activeMeta.icon size={18} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{info.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {info.detail}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(item.ingestedAt)}
                </div>
                {info.url && (
                  <a
                    href={info.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Open source"
                  >
                    <ArrowSquareOut size={16} />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
