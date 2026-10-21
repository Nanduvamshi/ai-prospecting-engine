import {
  LEAD_CREDIT_COST,
  calculateLeadCost,
  calculateTotalLeadsCost,
  truncateLeadsToBudget,
} from '@/server/billing/lead-credit-cost';

/**
 * This is the arithmetic that decides what a user is charged, and it runs
 * after the pipeline has already done the work — so a mistake here either
 * bills for something that was never delivered or gives it away.
 */

const basic = { name: 'no contact details' };
const withEmail = { email: 'ada@example.com' };
const withPhone = { phone: '4155551000' };
const enriched = { email: 'ada@example.com', companyEnrichment: { employees: 40 } };
const signalled = { email: 'ada@example.com', intentSignals: { funding: true } };

describe('calculateLeadCost', () => {
  it('charges the basic rate when there is no way to contact the lead', () => {
    expect(calculateLeadCost(basic, 'quick')).toBe(LEAD_CREDIT_COST.BASIC);
    expect(calculateLeadCost(basic, 'deep')).toBe(LEAD_CREDIT_COST.BASIC);
  });

  it('charges the enriched rate once either an email or a phone is present', () => {
    expect(calculateLeadCost(withEmail, 'quick')).toBe(LEAD_CREDIT_COST.ENRICHED);
    expect(calculateLeadCost(withPhone, 'quick')).toBe(LEAD_CREDIT_COST.ENRICHED);
  });

  it('charges more for the same contact details found on a deep run', () => {
    expect(calculateLeadCost(withEmail, 'deep')).toBe(LEAD_CREDIT_COST.DEEP_ENRICHED);
  });

  it('charges the full rate only for a deep run that produced contact details and enrichment', () => {
    expect(calculateLeadCost(enriched, 'deep')).toBe(LEAD_CREDIT_COST.DEEP_FULL);
    expect(calculateLeadCost(signalled, 'deep')).toBe(LEAD_CREDIT_COST.DEEP_FULL);
    // Same lead on a quick run is not full price.
    expect(calculateLeadCost(enriched, 'quick')).toBe(LEAD_CREDIT_COST.ENRICHED);
  });

  it('does not treat an empty enrichment object as enrichment', () => {
    // Providers that self-skip can leave the key present but empty; billing
    // for that would charge for work nobody did.
    expect(calculateLeadCost({ email: 'a@b.com', companyEnrichment: {} }, 'deep')).toBe(
      LEAD_CREDIT_COST.DEEP_ENRICHED,
    );
  });

  it('defaults to quick pricing when no depth is given', () => {
    expect(calculateLeadCost(withEmail)).toBe(LEAD_CREDIT_COST.ENRICHED);
  });
});

describe('calculateTotalLeadsCost', () => {
  it('sums per-lead cost rather than assuming a flat rate', () => {
    expect(calculateTotalLeadsCost([basic, withEmail, enriched], 'deep')).toBe(
      LEAD_CREDIT_COST.BASIC + LEAD_CREDIT_COST.DEEP_ENRICHED + LEAD_CREDIT_COST.DEEP_FULL,
    );
  });

  it('costs nothing for no leads', () => {
    expect(calculateTotalLeadsCost([], 'deep')).toBe(0);
  });
});

describe('truncateLeadsToBudget', () => {
  it('returns everything when the budget covers it', () => {
    const result = truncateLeadsToBudget([withEmail, withEmail], 100, 'quick');
    expect(result.leads).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.cost).toBe(2 * LEAD_CREDIT_COST.ENRICHED);
  });

  it('returns what the budget allows instead of failing the whole run', () => {
    // The pipeline already spent the money reaching these leads. Handing back
    // a shorter list beats throwing away a completed run.
    const result = truncateLeadsToBudget([withEmail, withEmail, withEmail], 5, 'quick');
    expect(result.leads).toHaveLength(2);
    expect(result.cost).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.originalCount).toBe(3);
  });

  it('never bills beyond the budget', () => {
    const result = truncateLeadsToBudget([enriched, enriched, enriched], 7, 'deep');
    expect(result.cost).toBeLessThanOrEqual(7);
  });

  it('preserves input order, so a score-sorted list keeps its best leads', () => {
    const leads = [
      { email: 'a@x.com', score: 90 },
      { email: 'b@x.com', score: 80 },
      { email: 'c@x.com', score: 70 },
    ];
    const result = truncateLeadsToBudget(leads, 4, 'quick');
    expect(result.leads.map((l) => l.score)).toEqual([90, 80]);
  });

  it('returns nothing at a zero budget without throwing', () => {
    const result = truncateLeadsToBudget([withEmail], 0, 'quick');
    expect(result.leads).toEqual([]);
    expect(result.cost).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('stops at the first unaffordable lead rather than skipping to a cheaper one', () => {
    // Taking a later, cheaper lead would reorder results by price instead of
    // by score — the user would silently lose their best match.
    const result = truncateLeadsToBudget([enriched, basic], 1, 'deep');
    expect(result.leads).toEqual([]);
  });
});
