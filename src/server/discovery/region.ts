import 'server-only';

/**
 * Country hints for search and phone parsing.
 *
 * The pipeline knows where it is looking — a filter says "Sydney, Australia",
 * an ICP names a geography — but nothing downstream ever used it. Searches went
 * out unbiased and phone validation hardcoded two countries, so an Australian
 * campaign returned venues in Falmouth and New York and attached a Miami
 * switchboard to a Sydney lead.
 *
 * The mapping is derived from `Intl.DisplayNames` rather than a hand-kept table.
 * A table of country names is the kind of thing that is 90% complete forever,
 * and the runtime already ships the data.
 */

/** ISO 3166-1 alpha-2, uppercase. */
export type RegionCode = string;

let nameToCode: Map<string, RegionCode> | null = null;

/**
 * Build the reverse index once: display name -> region code.
 *
 * `Intl.DisplayNames` maps a code to a name, so the reverse needs a sweep of
 * the code space. There are only ~260 two-letter combinations that resolve, and
 * this runs once per process.
 */
function index(): Map<string, RegionCode> {
  if (nameToCode) return nameToCode;

  const map = new Map<string, RegionCode>();
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        let name: string | undefined;
        try {
          name = display.of(code);
        } catch {
          continue;
        }
        // An unassigned code returns the code itself rather than throwing.
        if (!name || name === code) continue;
        map.set(name.toLowerCase(), code);
      }
    }
  } catch {
    // Intl data unavailable — the aliases below still cover the common cases.
  }

  // Names people actually type, which the canonical list does not carry.
  const aliases: Record<string, RegionCode> = {
    usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
    'united states of america': 'US',
    uk: 'GB', 'u.k.': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
    scotland: 'GB', wales: 'GB',
    uae: 'AE', 'south korea': 'KR', 'north korea': 'KP',
    russia: 'RU', vietnam: 'VN', czechia: 'CZ',
  };
  for (const [name, code] of Object.entries(aliases)) map.set(name, code);

  nameToCode = map;
  return map;
}

/**
 * Resolve free text to a region code.
 *
 * Accepts a bare code ("AU"), a country name ("Australia"), or a longer
 * location string where the country is one comma-separated part
 * ("Bondi, Sydney, Australia"). Returns null rather than guessing — an
 * unbiased search beats a wrongly biased one.
 */
export function toRegionCode(input?: string | null): RegionCode | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  const map = index();

  // A bare alpha-2 code, but only if it names a real region — otherwise "in"
  // as the English preposition would silently become India.
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const code = raw.toUpperCase();
    for (const value of map.values()) if (value === code) return code;
  }

  const direct = map.get(raw.toLowerCase());
  if (direct) return direct;

  // Country is conventionally last, so walk from the right.
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = map.get(parts[i]);
    if (hit) return hit;
  }

  return null;
}

/** First resolvable region across several hints, in priority order. */
export function firstRegion(...hints: Array<string | string[] | null | undefined>): RegionCode | null {
  for (const hint of hints) {
    if (!hint) continue;
    for (const value of Array.isArray(hint) ? hint : [hint]) {
      const code = toRegionCode(value);
      if (code) return code;
    }
  }
  return null;
}

/**
 * Country-code TLDs worth trying when guessing a domain, most likely first.
 *
 * Only for regions where a ccTLD is the norm for business. Somewhere like the
 * US, where `.com` dominates, contributes nothing here and falls through to the
 * generic list.
 */
const CC_TLDS: Record<RegionCode, string[]> = {
  AU: ['com.au', 'au', 'net.au'],
  GB: ['co.uk', 'uk', 'org.uk'],
  NZ: ['co.nz', 'nz'],
  IN: ['in', 'co.in'],
  CA: ['ca'],
  DE: ['de'],
  FR: ['fr'],
  NL: ['nl'],
  ES: ['es'],
  IT: ['it'],
  BR: ['com.br'],
  MX: ['mx', 'com.mx'],
  ZA: ['co.za'],
  SG: ['com.sg', 'sg'],
  AE: ['ae'],
  IE: ['ie'],
  JP: ['jp', 'co.jp'],
  SE: ['se'],
  NO: ['no'],
  DK: ['dk'],
  PL: ['pl'],
  CH: ['ch'],
  AT: ['at'],
  BE: ['be'],
};

export function ccTldsFor(region?: RegionCode | null): string[] {
  if (!region) return [];
  return CC_TLDS[region.toUpperCase()] ?? [];
}
