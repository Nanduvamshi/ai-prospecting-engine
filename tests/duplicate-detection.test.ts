import { findDuplicates } from '@/server/prospects/duplicate-detection';

/**
 * Duplicate detection gates every import, so a false positive here does not
 * surface as an error — it silently drops a legitimate prospect and reports
 * it as a duplicate. That failure mode is the reason this file exists.
 */

type Existing = Parameters<typeof findDuplicates>[1][number];

const rows = (...names: Array<[string, string] | [string, string, Partial<Existing>]>): Existing[] =>
  names.map(([prospectId, name, extra]) => ({ prospectId, name, ...extra }));

describe('findDuplicates', () => {
  describe('email', () => {
    it('matches regardless of case and surrounding whitespace', () => {
      const matches = findDuplicates(
        { email: '  ADA@Example.COM ' },
        rows(['p1', 'Ada Lovelace', { email: 'ada@example.com' }]),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ prospectId: 'p1', matchType: 'email', confidence: 95 });
    });

    it('does not match a different address at the same domain', () => {
      expect(
        findDuplicates({ email: 'ada@example.com' }, rows(['p1', 'Bob', { email: 'bob@example.com' }])),
      ).toEqual([]);
    });
  });

  describe('phone', () => {
    it('ignores formatting and country prefix', () => {
      const matches = findDuplicates(
        { phone: '+1 (415) 555-1000' },
        rows(['p1', 'Ada', { phone: '4155551000' }]),
      );
      expect(matches[0]).toMatchObject({ matchType: 'phone', confidence: 85 });
    });

    it('ignores numbers too short to identify anyone', () => {
      // Normalisation keeps the last ten digits, so a short extension would
      // otherwise collide with any other short extension.
      expect(findDuplicates({ phone: '12345' }, rows(['p1', 'Ada', { phone: '12345' }]))).toEqual([]);
    });
  });

  describe('name similarity', () => {
    it('needs a corroborating company before a name alone counts as a match', () => {
      // A name-only match must be exact. A subset match ("Jon Smith" against
      // "Jon Michael Smith") scores 80, which becomes 80 * 0.6 = 48 and falls
      // two points under the >= 50 reporting threshold.
      //
      // Documenting rather than asserting an intent: the two-point gap looks
      // more like arithmetic than a decision, and the subset branch describes
      // itself as "a strong signal" while being unreachable without a company.
      // Left as-is deliberately — loosening it makes dedupe more aggressive,
      // and over-matching here silently discards real prospects on import.
      expect(findDuplicates({ name: 'Jon Smith' }, rows(['p1', 'Jon Michael Smith']))).toEqual([]);

      const withCompany = findDuplicates(
        { name: 'Jon Smith', companyName: 'Acme' },
        rows(['p1', 'Jon Michael Smith', { companyName: 'Acme' }]),
      );
      expect(withCompany).toHaveLength(1);
      expect(withCompany[0].matchType).toBe('name_company');
    });

    it('matches an identical name on its own', () => {
      const matches = findDuplicates({ name: 'Ada Lovelace' }, rows(['p1', '  ada   LOVELACE ']));
      expect(matches).toHaveLength(1);
      expect(matches[0].matchType).toBe('name_company');
    });

    it('does not treat a longer surname as the same person', () => {
      // Regression: comparing with `a.includes(b)` made any name that was a
      // character prefix of another score 80 — "Jon Smith" matched
      // "Jon Smithson", "Dan Lee" matched "Dan Leeds". On import those
      // legitimate prospects would be dropped as duplicates silently.
      //
      // The company has to be present for this to be a real regression test.
      // Without one the score lands at 80 * 0.6 = 48 and the >= 50 threshold
      // masks the bug — which is why it survived to reach import, where rows
      // do carry a company.
      const smithson = findDuplicates(
        { name: 'Jon Smith', companyName: 'Acme' },
        rows(['p1', 'Jon Smithson', { companyName: 'Acme' }]),
      );
      expect(smithson).toEqual([]);

      const leeds = findDuplicates(
        { name: 'Dan Lee', companyName: 'Acme' },
        rows(['p1', 'Dan Leeds', { companyName: 'Acme' }]),
      );
      expect(leeds).toEqual([]);
    });

    it('scores higher when the company agrees than when it conflicts', () => {
      const target = { name: 'Ada Lovelace', companyName: 'Analytical Engines' };
      const agreeing = findDuplicates(
        target,
        rows(['p1', 'Ada Lovelace', { companyName: 'Analytical Engines' }]),
      );
      const conflicting = findDuplicates(
        target,
        rows(['p2', 'Ada Lovelace', { companyName: 'Babbage Industries' }]),
      );

      expect(agreeing[0].confidence).toBeGreaterThan(conflicting[0].confidence);
    });
  });

  describe('result set', () => {
    it('reports each prospect once, by its strongest signal', () => {
      // Same person on every axis: a naive implementation appends a match per
      // rule and reports one prospect three times.
      const matches = findDuplicates(
        { name: 'Ada Lovelace', email: 'ada@example.com', phone: '4155551000' },
        rows(['p1', 'Ada Lovelace', { email: 'ada@example.com', phone: '4155551000' }]),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].matchType).toBe('email');
    });

    it('returns strongest first', () => {
      const matches = findDuplicates(
        { name: 'Ada Lovelace', email: 'ada@example.com' },
        rows(['weak', 'Ada Lovelace'], ['strong', 'Someone Else', { email: 'ada@example.com' }]),
      );
      expect(matches.map((m) => m.prospectId)).toEqual(['strong', 'weak']);
    });

    it('skips the excluded id so editing a prospect never flags itself', () => {
      expect(
        findDuplicates({ email: 'ada@example.com' }, rows(['p1', 'Ada', { email: 'ada@example.com' }]), 'p1'),
      ).toEqual([]);
    });

    it('returns nothing when the target carries no comparable field', () => {
      expect(findDuplicates({}, rows(['p1', 'Ada', { email: 'ada@example.com' }]))).toEqual([]);
    });
  });
});
