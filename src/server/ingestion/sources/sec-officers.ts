/**
 * SEC EDGAR — public-company officer extraction.
 *
 * DEF 14A proxy statements + 10-K filings name every Section 16 officer
 * (CEO, CFO, officers, directors). We pull recent filings via the EDGAR
 * full-text search API, fetch each document, and extract `Name — Title`
 * pairs via regex.
 *
 * Honest scope: DEF 14A HTML is wildly inconsistent across filers. This
 * adapter ships as a BEST-EFFORT extractor (30-50% yield on a typical
 * batch). Records are marked `confidence: 0.3` to reflect that. A
 * proper LLM-powered extractor is a follow-up.
 *
 * Rate limits: SEC caps at 10 req/s with a real User-Agent. We sleep
 * 150ms between document fetches to stay well under.
 */

import type { PublicContactRecord, PublicDataAdapter, IngestStats } from '../types';
import { savePublicRoles } from '../public-role-store';
import { getProviderRouter } from '@/server/ai/providers';

const UA = `prospecting-public-data ${process.env.SEC_CONTACT_EMAIL ?? 'contact@example.com'}`;
const SLEEP_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(15_000),
      // `cache: no-store` bypasses Next.js 15+'s fetch-response cache —
      // without it, Next caches the iXBRL viewer (~6KB wrapper) and
      // silently returns that on subsequent fetches, truncating real
      // 500kB+ filing bodies.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface EdgarHit {
  _id?: string;
  _source?: {
    adsh?: string;
    ciks?: string | string[];
    display_names?: string[];
    form?: string;
    file_date?: string;
  };
}

async function fetchRecentFilings(formType: 'DEF 14A' | '10-K', sinceDays: number): Promise<EdgarHit[]> {
  const dateFrom = new Date(Date.now() - sinceDays * 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://efts.sec.gov/LATEST/search-index?q=&dateRange=custom&startdt=${dateFrom}&forms=${encodeURIComponent(formType)}`;
  const data = await fetchJson<{ hits?: { hits?: EdgarHit[] } }>(url);
  return data?.hits?.hits || [];
}

function filingDocUrl(hit: EdgarHit): string | null {
  const ciks = hit._source?.ciks;
  const cik = Array.isArray(ciks) ? ciks[0] : ciks;
  const adsh = hit._source?.adsh;
  if (!cik || !adsh) return null;
  // EDGAR filing index: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<cik>&type=<form>
  // But direct document URL needs the accession number's folder structure.
  const accession = adsh.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${adsh}-index.htm`;
}

function companyFromHit(hit: EdgarHit): string | null {
  const names = hit._source?.display_names;
  if (!names || names.length === 0) return null;
  // Format: "Company Name (CIK 0001234)" — strip the suffix
  return names[0].split('(CIK')[0].trim() || null;
}

// ─── Officer extraction from filing HTML ────────────────────────────

const TITLE_KEYWORDS = [
  'chief executive officer', 'chief financial officer', 'chief operating officer',
  'chief technology officer', 'chief marketing officer', 'chief product officer',
  'chief revenue officer', 'chief people officer', 'chief information officer',
  'chief legal officer', 'general counsel', 'president', 'founder', 'co-founder',
  'executive vice president', 'senior vice president', 'vice president',
  'managing director', 'director',
];

// Tokens that appear in titles, never in real human names. If every
// word in the captured "name" slot is in this set, the regex caught a
// title fragment (e.g. "Executive Vice President") instead of an
// actual name. Common failure mode when a filing lists multiple
// officers in a single run-on sentence.
const TITLE_TOKENS = new Set([
  // Role types
  'chief', 'executive', 'vice', 'president', 'officer', 'officers', 'director', 'directors',
  'senior', 'managing', 'general', 'counsel', 'founder', 'founders', 'co-founder',
  'treasurer', 'secretary', 'chairman', 'chairwoman', 'chairperson',
  'chair', 'principal', 'deputy', 'assistant', 'associate', 'head',
  'lead', 'partner', 'trustee', 'board', 'advisor', 'consultant',
  // Function words commonly inside titles
  'operating', 'financial', 'technology', 'technical', 'information',
  'marketing', 'revenue', 'legal', 'people', 'product', 'business',
  'development', 'engineering', 'strategy', 'operations', 'data',
  'security', 'compliance', 'administrative', 'innovation', 'growth',
  'customer', 'sales', 'commercial', 'accounting',
  // Filler / prepositions / pronouns / verbs that leak from regex captures
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'by', 'to',
  'our', 'his', 'her', 'their', 'its', 'my', 'your',
  'became', 'was', 'is', 'were', 'are', 'had', 'has', 'have',
  'will', 'been', 'being', 'served', 'serves', 'serve', 'acting',
  'appointed', 'elected', 'named', 'joined', 'retired', 'resigned',
  'current', 'former', 'prior', 'interim', 'acting',
  // Suffixes / connectors
  'co', 'inc', 'llc', 'corp', 'ltd',
  // Abbreviations
  'vgi', 'ceo', 'cfo', 'coo', 'cto', 'cmo', 'cpo', 'cio', 'clo', 'cso',
]);

/**
 * Reject "name" strings that are actually title fragments or
 * junk text. Used to post-filter regex matches before save.
 */
function looksLikeRealName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 4 || trimmed.length > 60) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;

  // If EVERY token is a known title-word, this isn't a name.
  const allTitleTokens = tokens.every((t) => TITLE_TOKENS.has(t.toLowerCase().replace(/[.,;:]$/, '')));
  if (allTitleTokens) return false;

  // Reject names that start with a stop-word/conjunction ("and Vice President").
  const firstLower = tokens[0].toLowerCase().replace(/[.,;:]$/, '');
  if (['and', 'or', 'the', 'a', 'an'].includes(firstLower)) return false;

  // Must have at least one token that looks name-shaped — capitalized
  // with lowercase interior (e.g. "Smith" not "CEO"). Two-letter
  // initials like "P." or "J." count as OK when paired with others.
  const hasNameShaped = tokens.some((t) => {
    const bare = t.replace(/[.,;:]$/, '');
    if (bare.length <= 2) return false;
    return /^[A-Z][a-z]+/.test(bare);
  });
  return hasNameShaped;
}

/**
 * Best-effort: find "<Name> — <Title>" patterns in filing text. Drops
 * obvious false positives (titles in text like "the president said ...").
 *
 * Patterns we catch:
 *   "John Doe, Chief Executive Officer"
 *   "John Doe   Chief Executive Officer   52"       (table row)
 *   "Name: John Doe \n Title: Chief Executive Officer"
 *
 * Patterns we MISS (acceptable — LLM pass is follow-up work):
 *   - Names with non-ASCII chars
 *   - Titles that don't contain one of our keywords
 *   - Filings that list officers in unusual structures (image tables, PDFs)
 */
function extractOfficers(text: string, company: string): Array<{ name: string; title: string }> {
  // Strip HTML tags crudely — the text still has enough structure for
  // regex against the keyword list.
  const plain = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  const results: Array<{ name: string; title: string }> = [];
  const seen = new Set<string>();

  for (const kw of TITLE_KEYWORDS) {
    // "John P. Doe, Chief Executive Officer" — name is 2-4 capitalized words before the title
    const re = new RegExp(`([A-Z][a-zA-Z.\\-']+(?:\\s+[A-Z][a-zA-Z.\\-']+){1,3})\\s*[,\\-—]\\s*(${kw})(?!\\w)`, 'gi');
    let m: RegExpExecArray | null;
    let iterations = 0;
    while ((m = re.exec(plain)) !== null) {
      if (iterations++ > 200) break; // runaway guard
      const name = m[1].trim();
      const title = m[2].trim();
      // Filter out "dear shareholders" type false positives + reject
      // title-only matches (the most common regex miss — see
      // looksLikeRealName for the full logic).
      if (!looksLikeRealName(name)) continue;
      if (name.toLowerCase().includes('company')) continue;
      if (name.toLowerCase().includes(company.toLowerCase().split(' ')[0])) continue;
      const key = `${name.toLowerCase()}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name, title: normalizeTitle(title) });
      if (results.length >= 20) return results; // cap per filing
    }
  }
  return results;
}

// ─── Fix 4 — Structured HTML table extractor ────────────────────────
//
// Proxy statements + 10-Ks usually list officers in a table like:
//
//   | Name         | Age | Position                  | Director Since |
//   | John Smith   | 54  | Chief Executive Officer   | 2018           |
//   | Jane Doe     | 47  | Director                  | 2020           |
//
// Parsing tables directly gives us STRUCTURED data (not LLM-prompted
// free text), so yield + accuracy is higher for filings that use the
// table pattern — which is most of them.
//
// Strategy:
//   1. Pull every <table> out of the raw HTML.
//   2. Skip tables without a header suggesting officer info.
//   3. Scan rows: if one cell looks name-shaped AND another cell
//      contains a title-word (Director, Officer, President, Chief, etc.),
//      emit { name, title }.
//
// No XBRL library needed — SEC filings are mostly HTML-with-iXBRL-tags,
// and the tables themselves are plain <tr>/<td>. Works on both
// DEF 14A and 10-K.

const TABLE_HEADER_HINT = /(name|director|officer|position|title|age|principal position)/i;
const TITLE_CELL_HINT = /(director|officer|president|chief|vice|chairman|chairwoman|chairperson|founder|counsel|secretary|treasurer|partner|manager|principal|head)/i;

function stripCell(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOfficersFromTables(
  docHtml: string,
  _company: string,
): Array<{ name: string; title: string }> {
  const results: Array<{ name: string; title: string }> = [];
  const seen = new Set<string>();
  const tables = docHtml.match(/<table[\s\S]*?<\/table>/gi) || [];

  for (const tbl of tables) {
    // Only consider tables whose header looks officer-ish. Skip finance
    // / stock / compensation tables — they'll otherwise pollute output.
    const header = (tbl.match(/<th[\s\S]*?<\/th>/gi) || []).map(stripCell).join(' | ');
    const firstRow = stripCell((tbl.match(/<tr[\s\S]*?<\/tr>/i) || [''])[0]);
    const headerText = `${header} ${firstRow}`.toLowerCase();
    if (!TABLE_HEADER_HINT.test(headerText)) continue;

    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripCell).filter(Boolean);
      if (cells.length < 2) continue;

      // Find the cell that looks like a full human name. Usually the
      // leftmost or second cell.
      const nameCell = cells.find((c) => {
        if (c.length < 4 || c.length > 80) return false;
        if (/\d/.test(c)) return false; // names don't contain digits
        return looksLikeRealName(c);
      });
      if (!nameCell) continue;

      // Find a cell that contains a title-word.
      const titleCell = cells.find((c) => c !== nameCell && TITLE_CELL_HINT.test(c) && c.length < 200);
      if (!titleCell) continue;

      // Clean the title — some table cells have trailing age/date fragments.
      const cleanTitle = titleCell.replace(/\s+since\s+\d{4}.*$/i, '').replace(/\s+age\s+\d+.*$/i, '').trim();
      if (cleanTitle.length < 4 || cleanTitle.length > 120) continue;

      const key = `${nameCell.toLowerCase()}|${cleanTitle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name: nameCell, title: normalizeTitle(cleanTitle) });
      if (results.length >= 30) return results;
    }
  }
  return results;
}

// ─── LLM extractor (Claude Haiku) ───────────────────────────────────
//
// Strategy:
//   1. Locate the officer-dense section of the filing (usually under
//      "Executive Officers", "Directors", or "Section 16 Reporting").
//   2. Extract a ~4000-char excerpt around it — the whole filing is
//      100k+ chars and blows through Haiku's practical input budget.
//   3. Ask Claude Haiku for strict JSON {name, title} pairs.
//   4. Filter anything that fails looksLikeRealName as a safety net
//      (Claude occasionally hallucinates "John Doe" placeholders).
//
// Cost: Haiku at ~$0.8/M input + $4/M output. A 4k-char excerpt ≈
// 1k tokens in, ~500 tokens out → ~$0.003 per filing. At 30 filings
// per run × 1 run/day → ~$0.09/day = $2.70/month. Tiny.

const OFFICER_SECTION_KEYWORDS = [
  // Standard DEF 14A / proxy patterns
  'executive officers', 'executive officer',
  'directors and executive officers', 'executive officers and directors',
  'information about our directors', 'information about our executive officers',
  'our directors', 'our executive officers',
  'current directors', 'current executive officers',
  'information about our nominees', 'director nominees',
  // 10-K item 10 patterns
  'directors, executive officers', 'directors and officers',
  'officers and directors', 'officers of the registrant',
  'officers of our company', 'officers of the company',
  // Section 16 / beneficial ownership
  'section 16', 'beneficial ownership',
  // Fix 2 — governance / leadership section patterns
  'board of directors', 'our board', 'corporate governance',
  'management team', 'leadership team', 'senior management',
  'meet our leadership', 'our leadership', 'executive leadership',
  'biographical information', 'biographies of our',
  'set forth below is information', 'the following persons',
  // Table-header phrasings that front officer lists
  'name and position', 'name and title', 'name and principal position',
  'name age position', 'name age title', 'name age principal position',
  'director since', 'officer since',
];

/**
 * Find up to N officer-dense sections in the filing. Returns a ranked
 * list of candidate excerpts; Fix 3 (multi-retry) tries each in order
 * until one yields officers.
 *
 * Always includes the first 8KB of the doc as a last-resort fallback —
 * proxy cover pages often name the CEO/Chair/Secretary even when no
 * keyword matches.
 */
function locateOfficerSections(plain: string, max = 4): string[] {
  if (plain.length < 200) return [];
  const lower = plain.toLowerCase();

  // Collect all keyword hits with position + keyword ranking
  const hits: Array<{ idx: number; kw: string }> = [];
  for (const kw of OFFICER_SECTION_KEYWORDS) {
    let from = 0;
    // Find multiple occurrences of the same keyword (tables can repeat)
    while (true) {
      const idx = lower.indexOf(kw, from);
      if (idx === -1) break;
      hits.push({ idx, kw });
      from = idx + kw.length;
      // cap per-keyword to 3 matches
      if (hits.filter((h) => h.kw === kw).length >= 3) break;
    }
  }
  hits.sort((a, b) => a.idx - b.idx);

  // Build candidate excerpts, dedupe by start position (avoid sending
  // nearly-identical slices to the LLM twice)
  const excerpts: string[] = [];
  const seen = new Set<number>();
  for (const { idx } of hits) {
    const start = Math.max(0, idx - 200);
    const snapped = Math.floor(start / 1000) * 1000; // dedupe within 1KB windows
    if (seen.has(snapped)) continue;
    seen.add(snapped);
    excerpts.push(plain.slice(start, start + 4200));
    if (excerpts.length >= max - 1) break;
  }

  // Always append the first-8KB fallback if not already covered by an
  // earlier excerpt (Fix 1).
  if (!seen.has(0)) {
    excerpts.push(plain.slice(0, 8000));
  }

  return excerpts;
}

async function extractOfficersWithLLM(
  plain: string,
  company: string,
): Promise<Array<{ name: string; title: string }>> {
  const excerpts = locateOfficerSections(plain);
  if (excerpts.length === 0) {
    console.log(`[sec-officers/llm] ${company}: no excerpt (plain text too short?)`);
    return [];
  }

  // Fix 3 — multi-excerpt retry. First excerpt that yields officers
  // wins. Each call is ~$0.003; 3 tries × 30 filings = $0.27/run worst
  // case (typically much less since most filings bail on try 1).
  for (let i = 0; i < excerpts.length; i++) {
    const attempt = await runLLMOnExcerpt(excerpts[i], company, i + 1, excerpts.length);
    if (attempt.length > 0) return attempt;
  }
  return [];
}

async function runLLMOnExcerpt(
  excerpt: string,
  company: string,
  attempt: number,
  total: number,
): Promise<Array<{ name: string; title: string }>> {
  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract real human officers (CEO, CFO, directors, VPs, etc.) named in this SEC filing for "${company}".

Return ONLY this JSON (no markdown, no prose):
{
  "officers": [
    { "name": "Full Name", "title": "Exact Title as written" }
  ]
}

Include anyone explicitly named with a role. Directors, officers, key managers — all count. Skip signature blocks that only say "/s/ John Smith" without a title nearby. If you're unsure about a pairing, include it anyway — the caller has a second-stage filter.

Preserve titles verbatim (don't abbreviate "Chief Executive Officer" → "CEO"). Full names only (first + last).

Return { "officers": [] } if nothing is found.

EXCERPT:
${excerpt}`,
      }],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return [];
    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    let parsed: { officers?: Array<{ name?: string; title?: string }> };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return [];
    }

    const rawOfficers = Array.isArray(parsed.officers) ? parsed.officers : [];
    const cleaned = rawOfficers
      .filter((o) => o.name && o.title)
      .map((o) => ({ name: String(o.name).trim(), title: normalizeTitle(String(o.title)) }));
    const keep = cleaned.filter((o) => looksLikeRealName(o.name));
    if (keep.length > 0) {
      console.log(`[sec-officers/llm] ${company}: try ${attempt}/${total} → ${keep.length} officers`);
    }
    return keep;
  } catch (err) {
    console.warn(`[sec-officers/llm] ${company}: extractor crashed:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

function normalizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

// ─── Adapter ─────────────────────────────────────────────────────────

export const secOfficerAdapter: PublicDataAdapter = {
  source: 'sec-edgar',

  isConfigured() {
    // EDGAR needs no auth. It IS rate-limited on User-Agent — we use a
    // hard-coded UA that identifies this service; fine to always run.
    return true;
  },

  async run(opts = {}): Promise<IngestStats> {
    const sinceDays = opts.sinceDays ?? 7;
    const stats: IngestStats = { source: 'sec-edgar', fetched: 0, extracted: 0, saved: 0, failed: 0 };

    // Prioritise DEF 14A (proxy statements); 10-K is a fallback with
    // lower officer-coverage but broader availability.
    const hits = [
      ...(await fetchRecentFilings('DEF 14A', sinceDays)),
      ...(await fetchRecentFilings('10-K', Math.min(sinceDays, 14))),
    ];
    stats.fetched = hits.length;

    // Cap per run to stay within cron runtime + SEC rate limits
    const capped = hits.slice(0, 30);
    const records: PublicContactRecord[] = [];

    for (const hit of capped) {
      const company = companyFromHit(hit);
      const url = filingDocUrl(hit);
      if (!company || !url) { stats.failed += 1; continue; }

      // Fetch the filing index page; extract the primary document URL from it
      const indexHtml = await fetchText(url);
      if (!indexHtml) { stats.failed += 1; await sleep(SLEEP_MS); continue; }

      // Find the primary filing document. EDGAR index pages list all
      // files in the filing; we want the main one, not exhibits /
      // cover letters / iXBRL viewer wrappers.
      //
      // SEC serves iXBRL-tagged filings through a viewer at
      // /ix?doc=/Archives/.../file.htm — that URL only returns a ~6KB
      // JS-loader wrapper, not the actual content. We MUST filter
      // those out and fetch the raw /Archives/ path instead.
      //
      // Heuristic order:
      //   1. Filename in /Archives/ path contains 10-k / def14a / annual
      //      — the direct raw iXBRL doc.
      //   2. Largest .htm file under /Archives/ (primary filings are
      //      500kB+, exhibits <20kB).
      // Extract all .htm/.html hrefs, filter out:
      //  - iXBRL viewer wrappers (/ix?doc=...) — return only a JS loader
      //  - SEC navigation links (/index.htm, /cgi-bin/..., /edgar/about)
      //    that appear on every EDGAR page footer/header
      const allHrefs = Array.from(indexHtml.matchAll(
        /href="([^"]+\.(?:htm|html))"/gi,
      ))
        .map((m) => m[1])
        .filter((h) => {
          if (h.startsWith('/ix?') || h.includes('/ix?doc=')) return false;
          // SEC site-wide nav links — not filing documents
          if (h === '/index.htm' || h === 'index.htm') return false;
          if (h.startsWith('/cgi-bin/')) return false;
          if (h.startsWith('/edgar/about')) return false;
          if (h.startsWith('/info/')) return false;
          return true;
        });

      // 1st pass: href name indicates primary filing doc (proxy, 10-K,
      // def14a, annual report naming conventions).
      let docPath: string | null = allHrefs.find((h) =>
        /(10-?k|def14a|annual|10k|proxy)/i.test(h),
      ) || null;

      // 2nd pass: first non-index, non-exhibit, non-nav htm. Index
      // filenames contain the accession number; exhibits use `ex`
      // prefix. The primary filing doc is typically neither.
      if (!docPath) {
        docPath = allHrefs.find((h) => {
          const basename = h.split('/').pop() || '';
          if (/^\d{10}-\d{2}-\d{6}-index/.test(basename)) return false;
          if (/^ex[-_\d]/i.test(basename)) return false;
          // Only relative paths or /Archives/ absolute paths count —
          // anything else is SEC nav.
          if (h.startsWith('/') && !h.startsWith('/Archives/')) return false;
          return true;
        }) || null;
      }

      // 3rd pass: first htm that's definitely a filing doc (under
      // /Archives/ or relative to the filing index). NEVER fall back
      // to SEC homepage.
      if (!docPath) {
        docPath = allHrefs.find((h) =>
          h.startsWith('/Archives/') || (!h.startsWith('/') && !h.startsWith('http')),
        ) || null;
      }

      // 4th pass: some filing index pages ONLY list the iXBRL viewer
      // link (/ix?doc=/Archives/.../file.htm) — no direct raw-doc
      // anchor. Extract the underlying /Archives/ path from the
      // viewer URL's query string.
      if (!docPath) {
        const viewerMatch = indexHtml.match(
          /href="\/ix\?doc=(\/Archives\/[^"]+\.(?:htm|html))"/i,
        );
        if (viewerMatch) docPath = viewerMatch[1];
      }

      if (!docPath) { stats.failed += 1; await sleep(SLEEP_MS); continue; }

      // Belt-and-suspenders: strip any accidental /ix?doc= prefix so
      // we fetch the raw document, not the viewer wrapper.
      docPath = docPath.replace(/^\/ix\?doc=/, '');

      const docUrl = new URL(docPath, url).href;
      await sleep(SLEEP_MS);
      const docText = await fetchText(docUrl);
      if (!docText) { stats.failed += 1; continue; }

      // Pre-strip to plain text once; reused by both extractors.
      const plain = docText
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');

      // Three-tier extraction, cheapest → most expensive:
      //
      //   1. HTML table parser (Fix 4) — structured, free, high
      //      accuracy when the filing uses a standard officers table.
      //   2. Claude Haiku on up-to-3 officer-section excerpts (Fix 3)
      //      — ~$0.003 per excerpt tried, stops at first non-empty.
      //   3. Regex fallback — last resort, marked low-confidence.
      //
      // Env override SEC_EXTRACTOR={regex|llm|table} forces a single
      // path (useful when LLM provider is degraded or costs need
      // pinning).
      const mode = process.env.SEC_EXTRACTOR || 'auto';
      let officers: Array<{ name: string; title: string }> = [];
      let usedExtractor: 'table' | 'llm' | 'regex' = 'regex';
      let confidence = 0.3;

      if (mode === 'auto' || mode === 'table') {
        officers = extractOfficersFromTables(docText, company);
        if (officers.length > 0) {
          usedExtractor = 'table';
          confidence = 0.7; // highest — structured table, no LLM interpretation
        }
      }
      if (officers.length === 0 && (mode === 'auto' || mode === 'llm')) {
        officers = await extractOfficersWithLLM(plain, company);
        if (officers.length > 0) {
          usedExtractor = 'llm';
          confidence = 0.6;
        }
      }
      if (officers.length === 0) {
        officers = extractOfficers(plain, company);
        usedExtractor = 'regex';
        confidence = 0.3;
      }
      stats.extracted += officers.length;
      // Include doc URL + sizes on zero-yield to diagnose fetch issues
      const sizeHint = officers.length === 0 ? ` url=${docUrl.slice(-80)} docText=${docText.length} plain=${plain.length}` : '';
      console.log(`[sec-officers] ${company}: ${officers.length} officers via ${usedExtractor}${sizeHint}`);

      for (const off of officers) {
        records.push({
          company,
          name: off.name,
          title: off.title,
          source: 'sec-edgar',
          sourceUrl: docUrl,
          sourceKind: hit._source?.form || 'DEF 14A',
          foundAt: new Date().toISOString(),
          confidence,
        });
      }
      await sleep(SLEEP_MS);
    }

    stats.saved = await savePublicRoles(records);
    stats.note = `processed ${capped.length}/${hits.length} filings (cap=30, mode=${process.env.SEC_EXTRACTOR || 'auto'})`;
    return stats;
  },
};
