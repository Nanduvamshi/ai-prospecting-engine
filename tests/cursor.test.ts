import { decodeCursor, encodeCursor, sortForQuery, type Cursor } from '@/server/db/cursor';

/**
 * Cursors arrive from the client as opaque base64, so anything can turn up
 * here: a stale cursor from a previous sort, one hand-edited in a URL, or
 * plain junk. Every one of those must degrade to "start from the beginning"
 * rather than produce a page built from a nonsense comparison.
 */

const score: Cursor = { v: 1, s: 'score', k: [85, 'p_42'] };
const recent: Cursor = { v: 1, s: 'recent', k: ['2026-08-19T12:00:00.000Z', 'p_42'] };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');

describe('cursor round-trip', () => {
  it('preserves a score cursor exactly', () => {
    expect(decodeCursor(encodeCursor(score), 'score')).toEqual(score);
  });

  it('preserves a recent cursor exactly', () => {
    expect(decodeCursor(encodeCursor(recent), 'recent')).toEqual(recent);
  });

  it('keeps the score numeric', () => {
    // The index this replaced compared the string "<score>#<id>", so "9#x"
    // sorted after "85#y". Keeping the score a number is the fix.
    const decoded = decodeCursor(encodeCursor(score), 'score');
    expect(typeof (decoded as { k: [number, string] }).k[0]).toBe('number');
  });
});

describe('cursor rejection', () => {
  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeCursor(raw as string | null | undefined, 'score')).toBeNull();
  });

  it.each([
    ['text that is not base64 JSON', 'not-a-cursor'],
    ['a JSON primitive', b64('nope')],
    ['an unknown version', b64({ v: 2, s: 'score', k: [85, 'p_42'] })],
    ['a tuple of the wrong arity', b64({ v: 1, s: 'score', k: [85] })],
    ['a non-array key', b64({ v: 1, s: 'score', k: 'p_42' })],
    ['a score that is not a number', b64({ v: 1, s: 'score', k: ['85', 'p_42'] })],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeCursor(raw as string, 'score')).toBeNull();
  });

  it('rejects an unparseable timestamp on a recent cursor', () => {
    expect(decodeCursor(b64({ v: 1, s: 'recent', k: ['whenever', 'p_42'] }), 'recent')).toBeNull();
  });

  it('rejects a cursor built for the other sort', () => {
    // Switching filters changes the comparison columns. Applying the old
    // cursor would silently return a wrong page rather than an empty one.
    expect(decodeCursor(encodeCursor(score), 'recent')).toBeNull();
    expect(decodeCursor(encodeCursor(recent), 'score')).toBeNull();
  });
});

describe('sortForQuery', () => {
  it('sorts by score when a status filter is applied', () => {
    expect(sortForQuery({ status: ['qualified'] })).toBe('score');
  });

  it('sorts by recency otherwise', () => {
    expect(sortForQuery({ status: [] })).toBe('recent');
    expect(sortForQuery({ status: null })).toBe('recent');
    expect(sortForQuery({})).toBe('recent');
  });
});
