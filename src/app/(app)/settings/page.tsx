'use client';

import { useCallback, useEffect, useState } from 'react';
import { Target, FloppyDisk, CheckCircle, Plugs } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { api, ApiError } from '@/lib/api-client';

/**
 * Settings — the ICP definition and a view of what is actually configured.
 *
 * The ICP feeds LLM fit scoring and the outreach drafter, so it is the one
 * piece of configuration that changes the engine's behaviour rather than just
 * its plumbing.
 */

interface Icp {
  industries?: string[];
  titles?: string[];
  geographies?: string[];
  companySizes?: string[];
  useCases?: string[];
  customCriteria?: string;
}

const SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;

/** Comma-separated input <-> string[], trimming blanks. */
function toList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export default function SettingsPage() {
  const [icp, setIcp] = useState<Icp>({});
  const [capabilities, setCapabilities] = useState<Record<string, Record<string, boolean>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [icpRes, health] = await Promise.all([
        api.get<{ icp: Icp | null }>('/api/icp'),
        api.get<{ capabilities: Record<string, Record<string, boolean>> }>('/api/health'),
      ]);
      setIcp(icpRes.icp ?? {});
      setCapabilities(health.capabilities ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Sent as the bare document — the endpoint also accepts { icp } and
      // rejects a payload with no recognised fields rather than silently
      // wiping what is stored.
      await api.post('/api/icp', icp);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the ICP.');
    } finally {
      setSaving(false);
    }
  };

  const toggleSize = (size: string) =>
    setIcp((prev) => {
      const current = prev.companySizes ?? [];
      return {
        ...prev,
        companySizes: current.includes(size)
          ? current.filter((s) => s !== size)
          : [...current, size],
      };
    });

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-heading text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Define who you sell to, and see what the engine can currently reach.
        </p>
      </header>

      <section className="space-y-4 rounded-card border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Target size={18} className="text-primary" />
          <h2 className="font-medium">Ideal customer profile</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Used to score how well a prospect fits, and to give the outreach drafter something
          specific to reference.
        </p>

        <Field
          label="Industries"
          hint="Comma separated"
          value={(icp.industries ?? []).join(', ')}
          onChange={(v) => setIcp((p) => ({ ...p, industries: toList(v) }))}
          placeholder="SaaS, Fintech, Developer tools"
        />
        <Field
          label="Target titles"
          hint="Comma separated"
          value={(icp.titles ?? []).join(', ')}
          onChange={(v) => setIcp((p) => ({ ...p, titles: toList(v) }))}
          placeholder="VP of Sales, Head of Growth"
        />
        <Field
          label="Geographies"
          hint="Comma separated"
          value={(icp.geographies ?? []).join(', ')}
          onChange={(v) => setIcp((p) => ({ ...p, geographies: toList(v) }))}
          placeholder="India, Germany, United States"
        />

        <div>
          <label className="mb-1.5 block text-sm font-medium">Company size</label>
          <div className="flex flex-wrap gap-2">
            {SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => toggleSize(size)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                  (icp.companySizes ?? []).includes(size)
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">
            Custom criteria
            <span className="ml-2 font-normal text-muted-foreground">Free text</span>
          </label>
          <textarea
            value={icp.customCriteria ?? ''}
            onChange={(e) => setIcp((p) => ({ ...p, customCriteria: e.target.value }))}
            rows={3}
            placeholder="Must have an outbound sales team of five or more"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            <FloppyDisk size={16} />
            {saving ? 'Saving…' : 'Save ICP'}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle size={16} weight="fill" />
              Saved
            </span>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-card border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Plugs size={18} className="text-primary" />
          <h2 className="font-medium">Configured providers</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Everything below self-skips when unconfigured — you simply get less enrichment. Set keys
          in <code className="rounded bg-muted px-1">.env</code> and restart.
        </p>

        {capabilities &&
          Object.entries(capabilities).map(([group, entries]) => (
            <div key={group}>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group}
              </div>
              <div className="flex flex-wrap gap-2">
                {typeof entries === 'boolean' ? (
                  <Pill on={entries} label={group} />
                ) : (
                  Object.entries(entries).map(([name, on]) => (
                    <Pill key={name} on={on} label={name} />
                  ))
                )}
              </div>
            </div>
          ))}
      </section>
    </div>
  );
}

function Field({
  label, hint, value, onChange, placeholder,
}: {
  label: string; hint?: string; value: string;
  onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">
        {label}
        {hint && <span className="ml-2 font-normal text-muted-foreground">{hint}</span>}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
      />
    </div>
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-1 text-xs font-medium',
        on ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground',
      )}
    >
      {on ? '● ' : '○ '}
      {label}
    </span>
  );
}
