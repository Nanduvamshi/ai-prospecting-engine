import 'server-only';

/**
 * Environment access.
 *
 * A common pattern is to fall back to a hard-coded value:
 *
 *     process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || '<some-pool-id>'
 *
 * ...which means any clone that forgets to set the variable silently talks to
 * whatever environment that literal points at — someone's production user
 * pool, billing gateway or API.
 *
 * So: `required()` throws, `optional()` returns undefined, and there are no
 * fallback literals anywhere. A missing required value is a startup crash,
 * not a surprise in production three weeks later.
 */

export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for what it is and how to set it.`,
    );
  }
  return value;
}

export function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

export function flag(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return defaultValue;
  return value === 'true' || value === '1' || value === 'yes';
}

export function integer(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Which optional providers are actually configured.
 *
 * Every one of these self-skips when unset — the pipeline degrades rather
 * than failing. This is logged once at startup so "why did I get no emails"
 * has an obvious answer instead of requiring a code read.
 */
export function capabilities() {
  return {
    ai: {
      anthropic: Boolean(optional('ANTHROPIC_API_KEY')),
      openai: Boolean(optional('OPENAI_API_KEY')),
      bedrock: flag('AI_BEDROCK_ENABLED'),
    },
    search: {
      serpapi: Boolean(optional('SERPAPI_API_KEY')),
      searxng: Boolean(optional('SEARXNG_URL') && optional('SEARXNG_KEY')),
      duckduckgo: true, // no key required — always available as a fallback
    },
    enrichment: {
      brightdata: Boolean(optional('BRIGHTDATA_API_TOKEN')),
      scraperPool: Boolean(optional('SCRAPER_POOL_URL') && optional('SCRAPER_POOL_KEY')),
      apollo: Boolean(optional('APOLLO_API_KEY')),
      crunchbase: Boolean(optional('CRUNCHBASE_API_KEY')),
      github: Boolean(optional('GITHUB_TOKEN')),
    },
    verification: {
      bouncer: Boolean(optional('BOUNCER_API_KEY')),
      fleet: Boolean(optional('VERIFIER_FLEET_URL')),
      inProcess: true, // SMTP probing always available
    },
    contactGraph: flag('CONTACT_GRAPH_ENABLED'),
  };
}

let logged = false;

/** Print the capability matrix once per process. */
export function logCapabilitiesOnce(): void {
  if (logged) return;
  logged = true;
  const c = capabilities();
  const live: string[] = [];
  const skipped: string[] = [];
  for (const [group, entries] of Object.entries(c)) {
    if (typeof entries === 'boolean') {
      (entries ? live : skipped).push(group);
      continue;
    }
    for (const [name, on] of Object.entries(entries)) {
      (on ? live : skipped).push(`${group}.${name}`);
    }
  }
  console.log('[capabilities] live:', live.join(', ') || '(none)');
  console.log('[capabilities] skipped:', skipped.join(', ') || '(none)');
  if (!c.ai.anthropic && !c.ai.openai && !c.ai.bedrock) {
    console.warn(
      '[capabilities] No AI provider configured. Lead extraction (pipeline phase 4) will fail fast with ai_unavailable. Set ANTHROPIC_API_KEY.',
    );
  }
}
