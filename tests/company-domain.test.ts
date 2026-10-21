import {
  distinctiveTokens,
  domainAffinity,
  domainLabel,
  scoreCandidate,
  type Candidate,
} from '@/server/discovery/company-domain';

/**
 * These fixtures are real search results, captured while debugging a Sydney
 * hospitality campaign that resolved zero domains across 79 leads. The
 * aggregators genuinely outranked the venues, which is the whole difficulty.
 */

const HIGH = 55;
const MEDIUM = 35;

function pick(company: string, candidates: Candidate[]): string | null {
  const scored = candidates
    .map((c) => ({ domain: c.domain, score: scoreCandidate(company, c) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score >= MEDIUM ? best.domain : null;
}

describe('domainLabel', () => {
  it('strips a single-part TLD', () => {
    expect(domainLabel('sailssydney.com')).toBe('sailssydney');
  });

  it('strips a multi-part country suffix', () => {
    // Dropping only the last dotted segment would leave "attimi.com", and
    // comparing a company name against "com" matches nothing.
    expect(domainLabel('attimi.com.au')).toBe('attimi');
    expect(domainLabel('mosmanrowers.com.au')).toBe('mosmanrowers');
    expect(domainLabel('example.co.uk')).toBe('example');
  });

  it('ignores www and takes the registrable label from a subdomain', () => {
    expect(domainLabel('www.attimi.com.au')).toBe('attimi');
    expect(domainLabel('shop.sailssydney.com')).toBe('sailssydney');
  });
});

describe('distinctiveTokens', () => {
  it('drops category and legal noise', () => {
    expect(distinctiveTokens('Sails on Lavender Bay Restaurant')).toEqual([
      'sails', 'lavender', 'bay',
    ]);
    expect(distinctiveTokens('Acme Hospitality Group Pty Ltd')).toEqual(['acme']);
  });

  it('folds accents so a name still yields tokens', () => {
    expect(distinctiveTokens('Café Küche')).toEqual(['kuche']);
  });

  it('returns nothing when a name is only noise', () => {
    expect(distinctiveTokens('The Restaurant Group')).toEqual([]);
  });
});

describe('domainAffinity', () => {
  it('measures token containment, not string similarity', () => {
    expect(domainAffinity('Mosman Rowers', 'mosmanrowers.com.au')).toBe(1);
    expect(domainAffinity('Sails on Lavender Bay Restaurant', 'bestrestaurants.com.au')).toBe(0);
  });
});

describe('scoreCandidate — real search results', () => {
  it('picks the venue own site over a higher-ranked directory', () => {
    // Observed ordering for "Sails on Lavender Bay Restaurant": the parent
    // group ranked first, an aggregator second, the venue itself third.
    const company = 'Sails on Lavender Bay Restaurant';
    expect(
      pick(company, [
        { domain: 'srghospitality.com.au', url: 'https://srghospitality.com.au/venue/sails/', rank: 0 },
        { domain: 'bestrestaurants.com.au', url: 'https://www.bestrestaurants.com.au/nsw/sydney/mcmahons-point/restaurant/sails-on-lavender-bay', rank: 1 },
        { domain: 'sailssydney.com', url: 'https://sailssydney.com/', rank: 2, title: 'Sails on Lavender Bay Restaurant' },
      ]),
    ).toBe('sailssydney.com');
  });

  it('accepts a one-word brand whose name has several tokens', () => {
    // Regression: a plain token-ratio gate scored this 1/3 and rejected it,
    // even though attimi.com.au is unambiguously the right answer.
    const company = 'Attimi by Dario Manca';
    const score = scoreCandidate(company, {
      domain: 'attimi.com.au',
      url: 'https://www.attimi.com.au/',
      rank: 0,
      title: 'Attimi by Dario Manca',
    });
    expect(score).toBeGreaterThanOrEqual(HIGH);
    expect(domainAffinity(company, 'attimi.com.au')).toBeLessThan(0.5);
  });

  it('rejects the directory listing for that same company', () => {
    expect(
      scoreCandidate('Attimi by Dario Manca', {
        domain: 'agfg.com.au',
        url: 'https://www.agfg.com.au/chef/dario-manca',
        rank: 2,
      }),
    ).toBeLessThan(MEDIUM);
  });

  it('accepts an exact-match domain outright', () => {
    expect(
      scoreCandidate('Mosman Rowers', {
        domain: 'mosmanrowers.com.au',
        url: 'https://www.mosmanrowers.com.au/contact-us',
        rank: 0,
      }),
    ).toBeGreaterThanOrEqual(HIGH);
  });

  it('accepts a parent group that shares no tokens, on corroboration alone', () => {
    // srghospitality.com.au is correct for "Sydney Restaurant Group" despite
    // zero token overlap — rank, root path and a naming title carry it.
    const score = scoreCandidate('Sydney Restaurant Group', {
      domain: 'srghospitality.com.au',
      url: 'https://srghospitality.com.au/',
      rank: 0,
      title: 'Home - SRG Hospitality',
      snippet: "Covering Sydney's harbourside icons and neighbourhood favourites",
    });
    expect(score).toBeGreaterThanOrEqual(MEDIUM);
  });

  it('penalises a generic directory label even when it ranks first', () => {
    expect(
      scoreCandidate('Single O', {
        domain: 'bestcafes.com.au',
        url: 'https://bestcafes.com.au/',
        rank: 0,
      }),
    ).toBeLessThan(MEDIUM);
  });

  it('scores zero when the company name carries no distinctive tokens', () => {
    expect(scoreCandidate('The Restaurant Group', { domain: 'anything.com', url: 'https://anything.com/', rank: 0 })).toBe(0);
  });
});
