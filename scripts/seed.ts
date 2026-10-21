/**
 * Development seed data.
 *
 * This is not optional garnish. With no API keys configured every provider
 * self-skips, so an unseeded database gives you a working app that renders
 * nothing — which looks broken and is hard to distinguish from actually
 * being broken.
 *
 * What gets seeded is chosen to exercise specific UI paths:
 *   - 25 prospects across every status, score band and owner, which is more
 *     than one page at the default size of 20, so cursor pagination is
 *     actually traversed rather than merely present
 *   - one completed find-leads job with realistic leads, and one frozen
 *     mid-run at phase 4, so the search progress UI renders without an LLM
 *   - an enrollment already past due, so the sequence cron does visible work
 *     on its first tick
 *
 * Idempotent: re-running replaces the seeded rows rather than duplicating.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';

const ORG_ID = process.env.DEV_ORG_ID ?? 'dev-org';
const USER_ID = process.env.DEV_USER_ID ?? 'dev-user';
const USER_EMAIL = process.env.DEV_USER_EMAIL ?? 'dev@localhost';
const OTHER_USER_ID = 'dev-user-2';

const FIRST = ['Priya', 'Arjun', 'Sara', 'Daniel', 'Mei', 'Tomás', 'Amara', 'Jonas', 'Lena', 'Rahul'];
const LAST = ['Sharma', 'Nakamura', 'Okonkwo', 'Weber', 'Lindqvist', 'Costa', 'Ferrari', 'Novak'];
const COMPANIES = [
  ['Latchkey', 'latchkey.io', 'Fintech'],
  ['Northwind Analytics', 'northwind-analytics.com', 'Data'],
  ['Beacon Health', 'beaconhealth.co', 'Healthcare'],
  ['Tessellate', 'tessellate.dev', 'Developer tools'],
  ['Harbour Logistics', 'harbourlogistics.com', 'Logistics'],
  ['Quillfeather', 'quillfeather.ai', 'AI'],
];
const TITLES = [
  'VP of Sales', 'Head of Growth', 'Chief Revenue Officer', 'Founder & CEO',
  'Director of Marketing', 'Head of Partnerships', 'VP Engineering', 'COO',
];
const STATUSES = ['new', 'researching', 'qualified', 'contacted', 'converted', 'disqualified'];
const SOURCES = ['linkedin', 'website', 'referral', 'event', 'manual', 'import'];

/** Deterministic pseudo-random so re-seeding produces the same fixtures. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function buildProspects() {
  const rnd = makeRng(20260819);
  const rows: (typeof schema.prospects.$inferInsert)[] = [];

  for (let i = 0; i < 25; i++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)];
    const last = LAST[Math.floor(rnd() * LAST.length)];
    const [company, domain, industry] = COMPANIES[Math.floor(rnd() * COMPANIES.length)];
    const status = STATUSES[i % STATUSES.length];
    const hasEmail = rnd() > 0.2;
    const hasPhone = rnd() > 0.5;

    rows.push({
      prospectId: `seed_prospect_${String(i + 1).padStart(3, '0')}`,
      orgId: ORG_ID,
      name: `${first} ${last}`,
      email: hasEmail ? `${first.toLowerCase()}.${last.toLowerCase()}@${domain}` : null,
      phone: hasPhone ? `+1415555${String(1000 + i)}` : null,
      company,
      title: TITLES[Math.floor(rnd() * TITLES.length)],
      linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
      website: `https://${domain}`,
      source: SOURCES[i % SOURCES.length],
      status,
      // Spread across bands so the score-descending sort is visibly ordered.
      score: 20 + ((i * 7) % 75),
      notes: i % 4 === 0 ? `Mentioned they are evaluating vendors this quarter.` : null,
      tags: i % 3 === 0 ? ['icp', industry.toLowerCase()] : [],
      enrichmentSources: hasEmail ? { email: i % 2 === 0 ? 'pattern' : 'apollo' } : null,
      // Two owners, so the owner filter has something to filter.
      ownerId: i % 3 === 0 ? OTHER_USER_ID : USER_ID,
      ownerName: i % 3 === 0 ? 'Second Seat' : 'Development User',
      createdAt: new Date(Date.now() - i * 36e5),
      updatedAt: new Date(Date.now() - i * 36e5),
    });
  }
  return rows;
}

const SAMPLE_LEADS = [
  { name: 'Priya Raman', title: 'VP of Sales', company: 'Latchkey', email: 'priya.raman@latchkey.io', score: 88 },
  { name: 'Daniel Weber', title: 'Head of Growth', company: 'Tessellate', email: 'd.weber@tessellate.dev', score: 81 },
  { name: 'Amara Okonkwo', title: 'Chief Revenue Officer', company: 'Beacon Health', email: '', score: 76 },
  { name: 'Jonas Lindqvist', title: 'Founder & CEO', company: 'Quillfeather', email: 'jonas@quillfeather.ai', score: 74 },
  { name: 'Mei Nakamura', title: 'Director of Marketing', company: 'Northwind Analytics', email: '', score: 69 },
].map((l, i) => ({
  ...l,
  companyDomain: `${l.company.toLowerCase().replace(/\s+/g, '')}.com`,
  linkedinUrl: `https://www.linkedin.com/in/seed-lead-${i}`,
  phone: i % 2 === 0 ? `+14155550${100 + i}` : '',
  website: '',
  twitterUrl: '', githubUrl: '', facebookUrl: '', avatar: '',
  location: ['Bangalore', 'Berlin', 'Lagos', 'Stockholm', 'Tokyo'][i],
  seniority: i < 2 ? 'VP' : 'C-level',
  department: 'Sales',
  confidence: i < 3 ? 'high' : 'medium',
  source: `https://www.linkedin.com/in/seed-lead-${i}`,
  emailVerified: Boolean(l.email),
}));

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See .env.example.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema });

  try {
    console.log('[seed] org + users');
    await db.insert(schema.orgs)
      .values({ orgId: ORG_ID, name: 'Development Org' })
      .onConflictDoNothing();

    await db.insert(schema.users).values([
      { userId: USER_ID, orgId: ORG_ID, email: USER_EMAIL, name: 'Development User', role: 'admin' },
      { userId: OTHER_USER_ID, orgId: ORG_ID, email: 'second@localhost', name: 'Second Seat', role: 'member' },
    ]).onConflictDoNothing();

    console.log('[seed] prospects');
    // Clear only seeded rows, so anything created by hand while testing stays.
    await db.delete(schema.prospects).where(eq(schema.prospects.orgId, ORG_ID));
    await db.insert(schema.prospects).values(buildProspects());

    console.log('[seed] find-leads jobs');
    await db.delete(schema.findLeadsJobs).where(eq(schema.findLeadsJobs.orgId, ORG_ID));

    await db.insert(schema.findLeadsJobs).values([
      {
        jobId: 'seed_job_completed',
        orgId: ORG_ID,
        userId: USER_ID,
        status: 'completed',
        phase: 8,
        phaseLabel: 'Done',
        percentComplete: 100,
        searchesRun: [
          'VP of Sales fintech Bangalore linkedin',
          '"head of growth" developer tools Berlin',
        ],
        summary: 'Found 5 senior go-to-market leaders at early-stage B2B companies.',
        request: { mode: 'ai', searchDepth: 'quick', sources: ['google'], prompt: 'VP Sales at seed-stage fintech' },
        metadata: { searchDepth: 'quick', leadsExtracted: 5, creditCost: 0, enrichmentApplied: true, hasMore: true },
        estimatedSeconds: 60,
        completedAt: new Date(),
      },
      {
        // Frozen mid-run so LeadSearchProgress renders its phase ticker
        // without needing an LLM call.
        jobId: 'seed_job_running',
        orgId: ORG_ID,
        userId: USER_ID,
        status: 'running',
        phase: 4,
        phaseLabel: 'Identifying promising leads…',
        percentComplete: 50,
        searchesRun: ['"chief revenue officer" healthcare SaaS'],
        request: { mode: 'filters', searchDepth: 'deep', sources: ['google', 'crunchbase'], jobTitles: 'CRO' },
        estimatedSeconds: 150,
      },
    ]);

    await db.insert(schema.findLeadsJobLeads).values([
      { jobId: 'seed_job_completed', partialLeads: SAMPLE_LEADS },
      { jobId: 'seed_job_running', partialLeads: SAMPLE_LEADS.slice(0, 2) },
    ]).onConflictDoNothing();

    console.log('[seed] ICP');
    await db.insert(schema.orgIcp).values({
      orgId: ORG_ID,
      icpKey: 'default',
      icp: {
        industries: ['SaaS', 'Fintech', 'Developer tools'],
        companySizes: ['11-50', '51-200'],
        titles: ['VP of Sales', 'Head of Growth', 'Chief Revenue Officer'],
        geographies: ['India', 'Germany', 'United States'],
        useCases: ['Cut sales response time', 'Unify outbound channels'],
        outreach: {
          companyName: 'Your Company',
          valueProp: 'An AI prospecting engine that finds and verifies decision-makers.',
          senderName: 'Development User',
          defaultTone: 'consultative',
        },
      },
      updatedBy: USER_ID,
    }).onConflictDoUpdate({
      target: [schema.orgIcp.orgId, schema.orgIcp.icpKey],
      set: { updatedAt: new Date() },
    });

    console.log('[seed] sequences + enrollments');
    await db.delete(schema.sequences).where(eq(schema.sequences.orgId, ORG_ID));
    await db.insert(schema.sequences).values([
      {
        sequenceId: 'seed_seq_intro',
        orgId: ORG_ID,
        name: 'Cold intro — 3 touch',
        description: 'Opener, nudge, break-up.',
        steps: [
          { id: 's1', type: 'send_email', delayDays: 0, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}} — saw {{company}} is hiring. Worth a chat?' },
          { id: 's2', type: 'wait', delayDays: 3 },
          { id: 's3', type: 'send_email', delayDays: 0, subject: 'Following up', body: 'Bumping this in case it slipped, {{firstName}}.' },
        ],
        exitOnReply: true,
        createdBy: USER_ID,
      },
      {
        sequenceId: 'seed_seq_reengage',
        orgId: ORG_ID,
        name: 'Re-engage cold leads',
        steps: [{ id: 'r1', type: 'send_email', delayDays: 0, subject: 'Still relevant?', body: 'Checking in, {{firstName}}.' }],
        exitOnReply: true,
        createdBy: USER_ID,
      },
    ]);

    const now = Date.now();
    await db.insert(schema.sequenceEnrollments).values([
      {
        // Already due — the cron does visible work on its very first tick.
        enrollmentId: 'seed_enr_due',
        orgId: ORG_ID,
        sequenceId: 'seed_seq_intro',
        prospectEmail: 'priya.sharma@latchkey.io',
        prospectName: 'Priya Sharma',
        prospectCompany: 'Latchkey',
        enrolledBy: USER_ID,
        status: 'running',
        currentStepIndex: 0,
        nextRunAt: new Date(now - 60_000),
        history: [{ at: new Date(now - 36e5).toISOString(), action: 'enrolled' }],
      },
      {
        enrollmentId: 'seed_enr_waiting',
        orgId: ORG_ID,
        sequenceId: 'seed_seq_intro',
        prospectEmail: 'd.weber@tessellate.dev',
        prospectName: 'Daniel Weber',
        enrolledBy: USER_ID,
        status: 'running',
        currentStepIndex: 1,
        nextRunAt: new Date(now + 2 * 864e5),
        history: [{ at: new Date(now - 864e5).toISOString(), action: 'sent step 0' }],
      },
      {
        enrollmentId: 'seed_enr_done',
        orgId: ORG_ID,
        sequenceId: 'seed_seq_reengage',
        prospectEmail: 'jonas@quillfeather.ai',
        enrolledBy: USER_ID,
        status: 'completed',
        currentStepIndex: 1,
        completedAt: new Date(now - 3 * 864e5),
        history: [{ at: new Date(now - 3 * 864e5).toISOString(), action: 'completed' }],
      },
    ]).onConflictDoNothing();

    console.log('[seed] intent sweep signals');
    await db.delete(schema.sweepItems);
    const sweeps: (typeof schema.sweepItems.$inferInsert)[] = [];
    const sweepTypes = ['funding', 'review', 'domain', 'social'] as const;
    for (let i = 0; i < 40; i++) {
      const type = sweepTypes[i % 4];
      sweeps.push({
        sweepType: type,
        itemHash: `seed${i}`,
        payload: {
          funding: { company: COMPANIES[i % 6][0], round: 'Series A', amount: '$12M', url: 'https://example.com/funding' },
          review: { company: COMPANIES[i % 6][0], rating: 2, quote: 'Support has been slow to respond.', source: 'G2' },
          domain: { domain: `${COMPANIES[i % 6][1]}`, registeredAt: new Date(now - i * 864e5).toISOString() },
          social: { platform: i % 2 ? 'reddit' : 'hn', title: 'Looking for alternatives to our current CRM', url: 'https://example.com/thread' },
        }[type],
        ingestedAt: new Date(now - i * 36e5),
      });
    }
    await db.insert(schema.sweepItems).values(sweeps).onConflictDoNothing();

    console.log('[seed] contact graph');
    await db.insert(schema.cgOrgParticipation)
      .values({ orgId: ORG_ID, optedIn: true, optedInAt: new Date(), optedInBy: USER_ID })
      .onConflictDoNothing();

    console.log('\n[seed] done.');
    console.log(`  org       ${ORG_ID}`);
    console.log('  prospects 25 across 6 statuses and 2 owners');
    console.log('  jobs      1 completed, 1 frozen at phase 4');
    console.log('  sequences 2, with 1 enrollment already due');
    console.log('  signals   40 sweep items across 4 types');
  } catch (err) {
    console.error('[seed] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
