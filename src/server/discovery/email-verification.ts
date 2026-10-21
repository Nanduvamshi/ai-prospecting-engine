/**
 * Email Verification — Tiered validation with in-house hardening.
 *
 * Tier 1: Bouncer Real-Time API (if BOUNCER_API_KEY is set).
 * Tier 2: In-house MX + SMTP RCPT TO probe with STARTTLS, catch-all
 *         detection, MX/rate-limit caches, and a dynamic disposable-domain
 *         blocklist.
 *
 * Phase A1 of the Track A (Bouncer replacement) plan: harden the fallback
 * path so it's production-grade without changing public call sites. Phase
 * A2 (dedicated verifier IP fleet) swaps the raw socket for a fleet
 * dispatcher but keeps the same public API.
 *
 * Public surface is deliberately backward-compat:
 *   - verifyEmail(): returns 'verified' | 'invalid'. Unknowns collapse to
 *     'invalid'; big-provider and catch-all domains stay 'verified' to
 *     avoid silently dropping real mail.
 *   - verifyEmailDetailed(): returns the full 4-state status + reason +
 *     timing for callers (fleet dispatcher, observability, tests) that
 *     need to distinguish "we couldn't tell" from "bad mailbox".
 */

import dns from 'dns';
import net from 'net';
import tls from 'tls';
import { randomUUID, createHash } from 'crypto';
import { getDisposableDomainsRecord } from './disposable-domains-store';
import { isVerifierFleetConfigured, verifyViaFleet } from './verifier-fleet-client';
import { getCachedVerification, saveCachedVerification } from './verification-cache-store';

// ─── Public types ───────────────────────────────────────────────────

export type VerificationResult = 'verified' | 'invalid';

export type DetailedStatus = 'verified' | 'invalid' | 'unknown' | 'catch-all';

export interface DetailedResult {
  status: DetailedStatus;
  /** Short reason string for logs/metrics (e.g. "rcpt_550", "mx_none") */
  reason: string;
  /** Last MX host probed, if any */
  mxUsed?: string;
  /** Elapsed time in ms */
  durationMs: number;
}

// ─── Static fallback blocklists ─────────────────────────────────────

const STATIC_DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'dispostable.com', 'trashmail.com', 'temp-mail.org', 'fakeinbox.com',
  'maildrop.cc', 'getairmail.com', '10minutemail.com',
]);

// Big-provider domains (Gmail, O365, Yahoo, etc.) whose MXes accept every
// RCPT TO at the gateway and only reject via bounce after the fact — SMTP
// probe is useless here. Without Bouncer we can only confirm the domain
// MX is real; the legacy API stays optimistic (returns 'verified') to
// match pre-hardening behaviour.
const BIG_PROVIDER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'zoho.com',
]);

// ─── Dynamic disposable-domain cache ────────────────────────────────

let dynamicDisposableDomains = new Set<string>();
let disposableLoadedAt = 0;
const DISPOSABLE_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h
let refreshInFlight: Promise<void> | null = null;

async function ensureDisposableListFresh(): Promise<void> {
  if (Date.now() - disposableLoadedAt < DISPOSABLE_REFRESH_MS) return;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const record = await getDisposableDomainsRecord();
      if (record?.domains?.length) {
        dynamicDisposableDomains = new Set(record.domains.map(d => d.toLowerCase()));
      }
      disposableLoadedAt = Date.now();
    } catch {
      // Swallow — fall back to static list until next refresh.
      disposableLoadedAt = Date.now();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Replace the in-memory disposable-domain set. Used by the sync cron. */
export function setDisposableDomains(domains: Iterable<string>): number {
  dynamicDisposableDomains = new Set(Array.from(domains, d => d.toLowerCase().trim()).filter(Boolean));
  disposableLoadedAt = Date.now();
  return dynamicDisposableDomains.size;
}

export function getDisposableDomainCount(): { static: number; dynamic: number } {
  return { static: STATIC_DISPOSABLE_DOMAINS.size, dynamic: dynamicDisposableDomains.size };
}

function isDisposable(domain: string): boolean {
  return STATIC_DISPOSABLE_DOMAINS.has(domain) || dynamicDisposableDomains.has(domain);
}

// ─── Format check ───────────────────────────────────────────────────

function isValidFormat(email: string): boolean {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
}

// ─── MX + catch-all caches ──────────────────────────────────────────

interface MxCacheEntry { records: string[]; expiresAt: number; }
interface CatchAllEntry { isCatchAll: boolean; expiresAt: number; }

const CACHE_MAX = 5000;
const MX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;           // 6h
const CATCH_ALL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

const mxCache = new Map<string, MxCacheEntry>();
const catchAllCache = new Map<string, CatchAllEntry>();

function lruTouch<T>(map: Map<string, T>, key: string, value: T, max: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function getMxRecords(domain: string): Promise<string[]> {
  const cached = mxCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    mxCache.delete(domain); mxCache.set(domain, cached); // bump LRU
    return cached.records;
  }
  const records = await new Promise<string[]>((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) return resolve([]);
      resolve(addresses.sort((a, b) => a.priority - b.priority).map(a => a.exchange));
    });
  });
  lruTouch(mxCache, domain, { records, expiresAt: Date.now() + MX_CACHE_TTL_MS }, CACHE_MAX);
  return records;
}

export function clearMxCache(): void { mxCache.clear(); }
export function clearCatchAllCache(): void { catchAllCache.clear(); }

// ─── Per-MX rate limiter (sliding window) ───────────────────────────
// Destination MXes (Google, O365, etc.) actively throttle repeat probes
// from the same source. Self-throttle to avoid tripping greylists /
// bans. Limit is conservative; Phase A2 adds a fleet of source IPs so
// the per-IP-per-MX limit scales with fleet size.

const MX_WINDOW_MS = 60_000;
const MX_MAX_REQUESTS_PER_WINDOW = 15;
const mxProbeLog = new Map<string, number[]>();

function isMxRateLimited(mxHost: string): boolean {
  const now = Date.now();
  const log = (mxProbeLog.get(mxHost) || []).filter(t => now - t < MX_WINDOW_MS);
  mxProbeLog.set(mxHost, log);
  return log.length >= MX_MAX_REQUESTS_PER_WINDOW;
}

function recordMxProbe(mxHost: string): void {
  const log = mxProbeLog.get(mxHost) || [];
  log.push(Date.now());
  if (log.length > 100) log.splice(0, log.length - 100);
  mxProbeLog.set(mxHost, log);
}

// ─── Tier routing: Bouncer vs fleet vs in-process ───────────────────
//
// During the Bouncer deprecation A/B (Track A exit criteria), we run
// both tiers in parallel. `EMAIL_VERIFIER_CANARY_PCT` is the percentage
// of traffic that should hit Bouncer; the rest goes to the fleet.
// Examples:
//   canaryPct=99 → 99% Bouncer / 1% fleet (early-ramp, fleet is new)
//   canaryPct=50 → even split during comparison
//   canaryPct=1  → 1% Bouncer keeps running as a canary while the fleet
//                  takes 99% of production
//   canaryPct=0  → fleet-only (happy path after A/B passes)
//
// Routing is deterministic on the email hash so the same address always
// hits the same tier — lets us compare agreement fairly.

function isBouncerConfigured(): boolean {
  return Boolean(process.env.BOUNCER_API_KEY);
}

function canaryPercent(): number {
  const raw = Number(process.env.EMAIL_VERIFIER_CANARY_PCT);
  if (!Number.isFinite(raw)) return 100;   // default = Bouncer-only when both configured
  return Math.max(0, Math.min(100, Math.floor(raw)));
}

function emailBucket(email: string): number {
  // Deterministic 0-99 bucket from email hash. Stable across processes so
  // the same email always routes to the same tier during a comparison
  // window.
  const hex = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 100;
}

type TierName = 'bouncer' | 'fleet' | 'in-process' | 'cache' | 'disposable' | 'format';

interface TierCounter {
  served: number;
  verified: number;
  invalid: number;
  unknown: number;
  catchAll: number;
  totalMs: number;
}

const tierStats: Record<TierName, TierCounter> = {
  bouncer: newCounter(),
  fleet: newCounter(),
  'in-process': newCounter(),
  cache: newCounter(),
  disposable: newCounter(),
  format: newCounter(),
};

function newCounter(): TierCounter {
  return { served: 0, verified: 0, invalid: 0, unknown: 0, catchAll: 0, totalMs: 0 };
}

function recordTier(tier: TierName, result: DetailedResult): void {
  const c = tierStats[tier];
  c.served += 1;
  c.totalMs += result.durationMs;
  if (result.status === 'verified') c.verified += 1;
  else if (result.status === 'invalid') c.invalid += 1;
  else if (result.status === 'catch-all') c.catchAll += 1;
  else c.unknown += 1;
}

/** Snapshot of per-tier verification counters — consumed by the admin status endpoint. */
export function getVerifierTierStats(): Record<TierName, TierCounter & { avgMs: number }> {
  const out = {} as Record<TierName, TierCounter & { avgMs: number }>;
  for (const key of Object.keys(tierStats) as TierName[]) {
    const c = tierStats[key];
    out[key] = { ...c, avgMs: c.served > 0 ? Math.round(c.totalMs / c.served) : 0 };
  }
  return out;
}

export function resetVerifierTierStats(): void {
  for (const key of Object.keys(tierStats) as TierName[]) {
    tierStats[key] = newCounter();
  }
}

async function validateWithBouncer(email: string, timeoutMs: number): Promise<DetailedResult> {
  const started = Date.now();
  const apiKey = process.env.BOUNCER_API_KEY;
  if (!apiKey) return { status: 'unknown', reason: 'bouncer_unconfigured', durationMs: Date.now() - started };
  try {
    const params = new URLSearchParams({ email });
    const res = await fetch(`https://api.usebouncer.com/v1/email/verify?${params}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: 'unknown', reason: `bouncer_${res.status}`, durationMs: Date.now() - started };
    const data = await res.json().catch(() => null) as { status?: string; reason?: string } | null;
    const status = (data?.status || '').toLowerCase();
    const reason = (data?.reason || '').toLowerCase();
    if (status === 'deliverable') return { status: 'verified', reason: 'bouncer_deliverable', durationMs: Date.now() - started };
    if (status === 'undeliverable') return { status: 'invalid', reason: `bouncer_undeliverable:${reason}`, durationMs: Date.now() - started };
    if (status === 'risky') {
      if (reason.includes('accept_all') || reason.includes('catch')) {
        return { status: 'catch-all', reason: 'bouncer_accept_all', durationMs: Date.now() - started };
      }
      return { status: 'unknown', reason: `bouncer_risky:${reason}`, durationMs: Date.now() - started };
    }
    return { status: 'unknown', reason: `bouncer_${status}`, durationMs: Date.now() - started };
  } catch {
    return { status: 'unknown', reason: 'bouncer_error', durationMs: Date.now() - started };
  }
}

// ─── Tier 2: raw SMTP with optional STARTTLS ────────────────────────

interface Reply { code: number; text: string; multiline: boolean; }

interface LineReader {
  read(timeoutMs: number): Promise<Reply>;
  send(cmd: string): void;
  upgradeTls(host: string, timeoutMs: number): Promise<void>;
  close(): void;
}

function makeLineReader(initial: net.Socket): LineReader {
  let active: net.Socket | tls.TLSSocket = initial;
  let buffer = '';
  const resolvers: Array<(v: Reply | Error) => void> = [];
  const pending: Reply[] = [];

  const handleChunk = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const nl = buffer.indexOf('\r\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (line.length < 3) continue;
      const code = parseInt(line.slice(0, 3), 10);
      if (Number.isNaN(code)) continue;
      const reply: Reply = {
        code,
        text: line.slice(4),
        multiline: line[3] === '-',
      };
      const resolve = resolvers.shift();
      if (resolve) resolve(reply);
      else pending.push(reply);
    }
  };
  const handleError = (err: Error) => { while (resolvers.length) resolvers.shift()!(err); };
  const handleClose = () => { while (resolvers.length) resolvers.shift()!(new Error('socket_closed')); };

  const attach = (s: net.Socket | tls.TLSSocket) => {
    s.on('data', handleChunk);
    s.on('error', handleError);
    s.on('close', handleClose);
  };
  const detach = (s: net.Socket | tls.TLSSocket) => {
    s.off('data', handleChunk);
    s.off('error', handleError);
    s.off('close', handleClose);
  };

  attach(initial);

  return {
    read(timeoutMs: number) {
      return new Promise<Reply>((resolve, reject) => {
        if (pending.length > 0) return resolve(pending.shift()!);
        const timer = setTimeout(() => {
          const idx = resolvers.indexOf(wrapper);
          if (idx >= 0) resolvers.splice(idx, 1);
          reject(new Error('smtp_read_timeout'));
        }, timeoutMs);
        const wrapper = (v: Reply | Error) => {
          clearTimeout(timer);
          if (v instanceof Error) reject(v);
          else resolve(v);
        };
        resolvers.push(wrapper);
      });
    },
    send(cmd: string) {
      try { active.write(cmd + '\r\n'); } catch { /* surfaces as next read timeout */ }
    },
    upgradeTls(host: string, timeoutMs: number) {
      return new Promise<void>((resolve, reject) => {
        detach(active);
        const timer = setTimeout(() => reject(new Error('starttls_timeout')), timeoutMs);
        const tlsSocket = tls.connect({
          socket: active,
          servername: host,
          rejectUnauthorized: false,
        }, () => {
          clearTimeout(timer);
          active = tlsSocket;
          attach(tlsSocket);
          resolve();
        });
        tlsSocket.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
    },
    close() { try { active.destroy(); } catch { /* ignore */ } },
  };
}

async function readFullReply(reader: LineReader, timeoutMs: number): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let code = 0;
  while (true) {
    const r = await reader.read(timeoutMs);
    code = r.code;
    lines.push(r.text);
    if (!r.multiline) break;
  }
  return { code, lines };
}

interface ProbeOptions {
  timeoutMs: number;
  preferStartTls: boolean;
  ehloDomain: string;
  fromAddress: string;
}

const DEFAULT_PROBE: ProbeOptions = {
  timeoutMs: 8000,
  preferStartTls: true,
  ehloDomain: process.env.SMTP_PROBE_DOMAIN ?? 'example.com',
  fromAddress: `verify@${process.env.SMTP_PROBE_DOMAIN ?? 'example.com'}`,
};

async function openSession(mxHost: string, opts: ProbeOptions): Promise<LineReader> {
  const socket = new net.Socket();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect_timeout')); }, opts.timeoutMs);
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    socket.connect(25, mxHost, () => { clearTimeout(timer); resolve(); });
  });

  const reader = makeLineReader(socket);

  const banner = await readFullReply(reader, opts.timeoutMs);
  if (banner.code < 200 || banner.code >= 400) {
    reader.close();
    throw new Error(`banner_${banner.code}`);
  }

  reader.send(`EHLO ${opts.ehloDomain}`);
  const ehlo = await readFullReply(reader, opts.timeoutMs);
  if (ehlo.code !== 250) { reader.close(); throw new Error(`ehlo_${ehlo.code}`); }

  const advertisesStartTls = ehlo.lines.some(l => /^STARTTLS/i.test(l.trim()));
  if (opts.preferStartTls && advertisesStartTls) {
    reader.send('STARTTLS');
    const tlsReply = await readFullReply(reader, opts.timeoutMs);
    if (tlsReply.code !== 220) { reader.close(); throw new Error(`starttls_${tlsReply.code}`); }
    await reader.upgradeTls(mxHost, opts.timeoutMs);
    reader.send(`EHLO ${opts.ehloDomain}`);
    const ehlo2 = await readFullReply(reader, opts.timeoutMs);
    if (ehlo2.code !== 250) { reader.close(); throw new Error(`ehlo2_${ehlo2.code}`); }
  }

  return reader;
}

/** Probe a single RCPT TO against mxHost. Caller handles aggregation across MXes. */
async function probeRcpt(mxHost: string, email: string, opts: ProbeOptions): Promise<DetailedResult> {
  const started = Date.now();
  let reader: LineReader | null = null;
  try {
    reader = await openSession(mxHost, opts);
    reader.send(`MAIL FROM:<${opts.fromAddress}>`);
    const mailFrom = await readFullReply(reader, opts.timeoutMs);
    if (mailFrom.code !== 250) {
      return { status: 'unknown', reason: `mailfrom_${mailFrom.code}`, mxUsed: mxHost, durationMs: Date.now() - started };
    }
    reader.send(`RCPT TO:<${email}>`);
    const rcpt = await readFullReply(reader, opts.timeoutMs);
    reader.send('QUIT');

    if (rcpt.code === 250 || rcpt.code === 251) {
      return { status: 'verified', reason: `rcpt_${rcpt.code}`, mxUsed: mxHost, durationMs: Date.now() - started };
    }
    if (rcpt.code >= 500 && rcpt.code < 600) {
      return { status: 'invalid', reason: `rcpt_${rcpt.code}`, mxUsed: mxHost, durationMs: Date.now() - started };
    }
    if (rcpt.code >= 400 && rcpt.code < 500) {
      return { status: 'unknown', reason: `rcpt_greylist_${rcpt.code}`, mxUsed: mxHost, durationMs: Date.now() - started };
    }
    return { status: 'unknown', reason: `rcpt_${rcpt.code}`, mxUsed: mxHost, durationMs: Date.now() - started };
  } catch (err) {
    return {
      status: 'unknown',
      reason: err instanceof Error ? err.message : 'probe_error',
      mxUsed: mxHost,
      durationMs: Date.now() - started,
    };
  } finally {
    if (reader) reader.close();
  }
}

/**
 * Probe a random address against mxHost to detect catch-all behaviour.
 * Cached per domain for 24h — a catch-all stance is fairly stable and we
 * don't want to burn reputation probing repeatedly.
 */
async function isDomainCatchAll(domain: string, mxHost: string, opts: ProbeOptions): Promise<boolean> {
  const cached = catchAllCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.isCatchAll;

  const probeAddress = `probe-${randomUUID().replace(/-/g, '')}@${domain}`;
  const result = await probeRcpt(mxHost, probeAddress, opts);
  const isCatchAll = result.status === 'verified';
  lruTouch(catchAllCache, domain, { isCatchAll, expiresAt: Date.now() + CATCH_ALL_CACHE_TTL_MS }, CACHE_MAX);
  return isCatchAll;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Full detailed verification. Callers that want to distinguish greylist /
 * catch-all / unknown from invalid should use this entry point.
 * `verifyEmail()` is the backward-compat shim.
 */
export async function verifyEmailDetailed(
  email: string,
  opts: Partial<ProbeOptions> = {},
): Promise<DetailedResult> {
  const started = Date.now();
  const probeOpts = { ...DEFAULT_PROBE, ...opts };

  if (!email || !isValidFormat(email)) {
    const result: DetailedResult = { status: 'invalid', reason: 'bad_format', durationMs: Date.now() - started };
    recordTier('format', result);
    return result;
  }
  const domain = email.split('@')[1].toLowerCase();

  // Refresh disposable list if stale. Fire-and-forget to avoid latency on
  // the first call after a stale period — the next call gets the fresh
  // list, this one may miss a recent add (acceptable).
  ensureDisposableListFresh().catch(() => {});

  // Phase A3 cache lookup — short-circuit before any SMTP / Bouncer /
  // fleet call. Opt out with VERIFICATION_CACHE_DISABLED=true for tests
  // or when debugging a specific probe path.
  if (process.env.VERIFICATION_CACHE_DISABLED !== 'true') {
    const cached = await getCachedVerification(email);
    if (cached) {
      const result: DetailedResult = {
        status: cached.status,
        reason: `cache:${cached.reason}`,
        mxUsed: cached.mxUsed,
        durationMs: Date.now() - started,
      };
      recordTier('cache', result);
      return result;
    }
  }

  if (isDisposable(domain)) {
    const result: DetailedResult = { status: 'invalid', reason: 'disposable', durationMs: Date.now() - started };
    saveCachedVerification(email, result, 'in-process').catch(() => {});
    recordTier('disposable', result);
    return result;
  }

  // Routing — see canaryPercent() for the A/B semantics. When only one
  // of {Bouncer, fleet} is configured, the canary value is ignored.
  const bouncerReady = isBouncerConfigured();
  const fleetReady = isVerifierFleetConfigured();
  const bucket = emailBucket(email);
  const sendToBouncer = bouncerReady && (!fleetReady || bucket < canaryPercent());

  if (sendToBouncer) {
    const result = await validateWithBouncer(email, probeOpts.timeoutMs);
    saveCachedVerification(email, result, 'bouncer').catch(() => {});
    recordTier('bouncer', result);
    return result;
  }

  if (fleetReady) {
    const fleetResult = await verifyViaFleet(email, probeOpts.timeoutMs);
    if (fleetResult.status !== 'unknown' || !fleetResult.reason.startsWith('fleet_')) {
      saveCachedVerification(email, fleetResult, 'fleet').catch(() => {});
      recordTier('fleet', fleetResult);
      return fleetResult;
    }
    console.warn(`[email-verifier] fleet returned ${fleetResult.reason}, falling back to in-process`);
  }

  // Tier 2b: in-process MX + SMTP probe (fallback when neither Bouncer
  // nor the fleet is configured, or when the fleet transport failed).
  const mxRecords = await getMxRecords(domain);
  if (mxRecords.length === 0) {
    const result: DetailedResult = { status: 'invalid', reason: 'mx_none', durationMs: Date.now() - started };
    saveCachedVerification(email, result, 'in-process').catch(() => {});
    recordTier('in-process', result);
    return result;
  }

  // Big-provider MXes accept everything at the gateway — SMTP probe is
  // unreliable. Without Bouncer we can only confirm the MX is real.
  if (BIG_PROVIDER_DOMAINS.has(domain)) {
    const result: DetailedResult = { status: 'unknown', reason: 'big_provider', mxUsed: mxRecords[0], durationMs: Date.now() - started };
    saveCachedVerification(email, result, 'in-process').catch(() => {});
    recordTier('in-process', result);
    return result;
  }

  for (const mx of mxRecords.slice(0, 2)) {
    if (isMxRateLimited(mx)) {
      // Transient — don't cache; next caller should retry.
      const result: DetailedResult = { status: 'unknown', reason: 'mx_rate_limited', mxUsed: mx, durationMs: Date.now() - started };
      recordTier('in-process', result);
      return result;
    }
    recordMxProbe(mx);

    const result = await probeRcpt(mx, email, probeOpts);

    if (result.status === 'verified') {
      // False-positive guard: if the domain accepts anything, this
      // verified-looking response is meaningless.
      const catchAll = await isDomainCatchAll(domain, mx, probeOpts).catch(() => false);
      if (catchAll) {
        const r: DetailedResult = { status: 'catch-all', reason: 'catch_all_domain', mxUsed: mx, durationMs: Date.now() - started };
        saveCachedVerification(email, r, 'in-process').catch(() => {});
        recordTier('in-process', r);
        return r;
      }
      saveCachedVerification(email, result, 'in-process').catch(() => {});
      recordTier('in-process', result);
      return result;
    }
    if (result.status === 'invalid') {
      saveCachedVerification(email, result, 'in-process').catch(() => {});
      recordTier('in-process', result);
      return result;
    }
    // 'unknown' → try next MX
  }

  // All MXes returned 'unknown' — transport-level flakiness, don't cache.
  const result: DetailedResult = { status: 'unknown', reason: 'all_mx_unknown', durationMs: Date.now() - started };
  recordTier('in-process', result);
  return result;
}

/**
 * Backward-compat boolean-ish verifier. Maps the richer detailed result
 * into the legacy 'verified' | 'invalid' shape with optimistic handling
 * for the cases where the old implementation would have returned
 * 'verified' anyway (big providers without Bouncer, catch-all domains).
 */
export async function verifyEmail(email: string, timeoutMs: number = 8000): Promise<VerificationResult> {
  const detailed = await verifyEmailDetailed(email, { timeoutMs });
  if (detailed.status === 'verified') return 'verified';
  if (detailed.status === 'catch-all') return 'verified';
  if (detailed.status === 'unknown' && detailed.reason === 'big_provider') return 'verified';
  return 'invalid';
}

export async function verifyEmails(
  emails: string[],
  concurrency: number = 3,
  timeoutMs: number = 8000,
): Promise<Map<string, VerificationResult>> {
  const results = new Map<string, VerificationResult>();
  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (email) => ({ email, result: await verifyEmail(email, timeoutMs) })),
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled') results.set(r.value.email, r.value.result);
      else results.set(batch[j], 'invalid');
    }
  }
  return results;
}
