import 'server-only';

/**
 * Keyset pagination cursors.
 *
 * The list API used to hand back a base64-encoded DynamoDB LastEvaluatedKey.
 * The wire format stays base64 so the client is untouched, but the payload is
 * now a keyset tuple matched to whichever sort is active.
 *
 * Two things this fixes:
 *
 *  - The old status-filtered index sorted on the string "<score>#<id>", so
 *    "9#abc" sorted *after* "85#xyz". Scores are compared as integers here.
 *
 *  - The old multi-status path could not merge cursors across partitions, so
 *    it fell back to querying each status separately and paginating with an
 *    in-memory offset. SQL takes `status = ANY(...)` with a single cursor,
 *    which is both correct and about forty lines shorter.
 *
 * Every cursor carries the row id as a tie-breaker. Without it, two prospects
 * with the same score (or the same created_at) can straddle a page boundary
 * and be returned twice or skipped.
 */

export type CursorSort = 'score' | 'recent';

export interface ScoreCursor {
  v: 1;
  s: 'score';
  /** [score, prospectId] */
  k: [number, string];
}

export interface RecentCursor {
  v: 1;
  s: 'recent';
  /** [createdAt ISO string, prospectId] */
  k: [string, string];
}

export type Cursor = ScoreCursor | RecentCursor;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64');
}

/**
 * Decode a cursor, returning null for anything unusable.
 *
 * A malformed cursor restarts from the first page rather than erroring. That
 * matches the old behaviour (which caught its JSON parse failure and logged a
 * warning) and it is the right call: a stale bookmarked cursor should show
 * the user a list, not a 500.
 */
export function decodeCursor(raw: string | null | undefined, expected: CursorSort): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;

    const candidate = decoded as Partial<Cursor>;
    if (candidate.v !== 1) return null;
    // A cursor from a different sort cannot be applied to this query — the
    // comparison columns differ. Restart rather than produce wrong pages.
    if (candidate.s !== expected) return null;
    if (!Array.isArray(candidate.k) || candidate.k.length !== 2) return null;

    if (candidate.s === 'score') {
      const [score, id] = candidate.k as [unknown, unknown];
      if (typeof score !== 'number' || typeof id !== 'string') return null;
      return { v: 1, s: 'score', k: [score, id] };
    }

    const [createdAt, id] = candidate.k as [unknown, unknown];
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { v: 1, s: 'recent', k: [createdAt, id] };
  } catch {
    return null;
  }
}

/**
 * Which sort a query should use.
 *
 * Score-descending when the caller filtered by status (that is what the
 * old status index was ordered by, and it is what the UI expects when you
 * pick "Qualified"). Recency otherwise.
 */
export function sortForQuery(opts: { status?: string[] | null }): CursorSort {
  return opts.status && opts.status.length > 0 ? 'score' : 'recent';
}
