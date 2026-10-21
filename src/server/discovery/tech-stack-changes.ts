/**
 * Tech Stack Change Detection — Phase 1 Signal 3.
 *
 * Detects when a prospect company SWITCHES tools — the single highest-intent
 * signal in outbound sales ("they just removed HubSpot's tracking pixel").
 *
 * Flow:
 *   1. On each scan, persist the detected tech-stack in Postgres.
 *   2. On a subsequent scan, diff against the previous record.
 *   3. Surface `added` (newly-installed tools) and `removed` (just-removed).
 *
 * Run this as a weekly cron over the active-deal pipeline, or on-demand
 * when a lead comes into the CRM.
 *
 * Storage schema on the main table:
 *   PK: `TECH_SCAN#<normalized-domain>`
 *   SK: `SCAN#<iso-timestamp>`
 *   technologies: string[] (names only — categories cached alongside)
 *   categories: Record<string, string>  name → category
 *   ttl: number (unix seconds, 180 days) — auto-expire stale scans
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { techScans } from '@/server/db/schema';
import { detectTechStack, type TechStackResult, type DetectedTech } from './tech-stack';

export interface TechStackChange {
  domain: string;
  /** ISO timestamps bracketing the diff */
  previousScanAt: string | null;
  currentScanAt: string;
  /** Tools present now but not in the prior scan */
  added: DetectedTech[];
  /** Tools present in the prior scan but not now */
  removed: DetectedTech[];
  /** Unchanged tools (stable baseline) */
  unchanged: DetectedTech[];
  /** True if this is the first scan — nothing to diff against */
  isFirstScan: boolean;
  /** Set when an added/removed tool was a CRM/helpdesk competitor — highest intent */
  competitorChangeDetected: boolean;
}

interface StoredScanRecord {
  PK: string;
  SK: string;
  technologies: string[];
  categories: Record<string, string>;
  scannedAt: string;
  ttl: number;
}

const NORMALIZE = (domain: string) => domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const TTL_SECONDS_180_DAYS = 180 * 24 * 60 * 60;

async function storeScan(scan: TechStackResult): Promise<void> {
  const timestamp = scan.detectedAt;
  await db
    .insert(techScans)
    .values({
      domain: NORMALIZE(scan.domain),
      scannedAt: new Date(timestamp),
      technologies: {
        technologies: scan.technologies.map(t => t.name),
        categories: Object.fromEntries(scan.technologies.map(t => [t.name, t.category])),
        scannedAt: timestamp,
      },
      expiresAt: new Date(Date.now() + TTL_SECONDS_180_DAYS * 1000),
    })
    // Re-scanning within the same millisecond is vanishingly unlikely, but a
    // conflict here should overwrite rather than throw and abort the sweep.
    .onConflictDoUpdate({
      target: [techScans.domain, techScans.scannedAt],
      set: {
        technologies: {
          technologies: scan.technologies.map(t => t.name),
          categories: Object.fromEntries(scan.technologies.map(t => [t.name, t.category])),
          scannedAt: timestamp,
        },
      },
    });
}

async function getMostRecentPreviousScan(
  domain: string,
  beforeTimestamp: string,
): Promise<StoredScanRecord | null> {
  // Served straight off the (domain, scanned_at) primary key.
  const rows = await db
    .select()
    .from(techScans)
    .where(
      and(
        eq(techScans.domain, NORMALIZE(domain)),
        lt(techScans.scannedAt, new Date(beforeTimestamp)),
      ),
    )
    .orderBy(desc(techScans.scannedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return row.technologies as unknown as StoredScanRecord;
}

function diffScans(
  current: TechStackResult,
  previous: { technologies: string[]; categories: Record<string, string> } | null,
): Omit<TechStackChange, 'domain' | 'currentScanAt' | 'previousScanAt' | 'isFirstScan'> {
  const prevNames = new Set(previous?.technologies || []);
  const prevCategories = previous?.categories || {};
  const currentNames = new Set(current.technologies.map(t => t.name));

  const added: DetectedTech[] = current.technologies.filter(t => !prevNames.has(t.name));
  const unchanged: DetectedTech[] = current.technologies.filter(t => prevNames.has(t.name));

  // Removed tools lose their evidence (not in current HTML anymore), so reconstruct.
  const removed: DetectedTech[] = [];
  for (const name of prevNames) {
    if (currentNames.has(name)) continue;
    removed.push({
      name,
      category: (prevCategories[name] || 'cms') as DetectedTech['category'],
      evidence: 'removed since last scan',
    });
  }

  const competitorChangeDetected =
    added.some(t => t.category === 'crm' || t.category === 'helpdesk') ||
    removed.some(t => t.category === 'crm' || t.category === 'helpdesk');

  return { added, removed, unchanged, competitorChangeDetected };
}

/**
 * Scan a domain, compare against the most-recent prior scan, and persist the result.
 *
 * Returns the diff. On the first scan, `isFirstScan: true` and added/removed are empty.
 * Subsequent calls will produce actionable change diffs.
 */
export async function detectTechStackChanges(domain: string): Promise<TechStackChange> {
  const current = await detectTechStack(domain);

  // If fetch failed entirely, persist nothing and return an empty-change record.
  if (current.error) {
    return {
      domain,
      previousScanAt: null,
      currentScanAt: current.detectedAt,
      added: [],
      removed: [],
      unchanged: [],
      isFirstScan: true,
      competitorChangeDetected: false,
    };
  }

  const previous = await getMostRecentPreviousScan(domain, current.detectedAt).catch(() => null);
  const diff = diffScans(current, previous);

  // Fire-and-forget persist (don't block response on DB write)
  storeScan(current).catch((err) => {
    console.error('[tech-stack-changes] storeScan failed:', err);
  });

  return {
    domain,
    previousScanAt: previous?.scannedAt || null,
    currentScanAt: current.detectedAt,
    ...diff,
    isFirstScan: previous === null,
  };
}

/**
 * Pure-function diff, exposed for unit testing or offline analysis.
 * Given a fresh scan and a prior scan record, compute what changed.
 */
export function computeTechStackDiff(
  current: TechStackResult,
  previous: { technologies: string[]; categories: Record<string, string> } | null,
): TechStackChange {
  return {
    domain: current.domain,
    previousScanAt: previous ? 'unknown' : null,
    currentScanAt: current.detectedAt,
    isFirstScan: previous === null,
    ...diffScans(current, previous),
  };
}
