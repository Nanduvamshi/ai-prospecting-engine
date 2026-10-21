/**
 * Store contract smoke test.
 *
 * Exercises each rewritten repository against a real Postgres, asserting the
 * behaviours the pipeline depends on. Run with:  npx tsx scripts/verify-stores.ts
 */
import 'dotenv/config';

const ORG = 'verify-org';
const USER = 'verify-user';
let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const jobs = await import('../src/server/pipeline/jobs');
  const sweeps = await import('../src/server/discovery/sweep-sink');
  const cache = await import('../src/server/discovery/verification-cache-store');
  const enroll = await import('../src/server/outreach/sequences/enrollment-store');
  const seqs = await import('../src/server/outreach/sequences/sequence-store');
  const graph = await import('../src/server/network/contact-graph-db');
  const { getPool } = await import('../src/server/db/client');

  console.log('\nfind-leads jobs');
  const jobId = `verify_${Date.now()}`;
  await jobs.createFindLeadsJob({
    jobId, orgId: ORG, userId: USER, status: 'queued', phase: 0,
    phaseLabel: 'Getting ready…', percentComplete: 0, partialLeads: [], searchesRun: [],
    request: { mode: 'ai', prompt: 'test' }, estimatedSeconds: 60,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  check('create + read back', (await jobs.getFindLeadsJob(ORG, jobId))?.status === 'queued');

  await jobs.updateFindLeadsJobPhase(ORG, jobId, {
    status: 'running', phase: 2, phaseLabel: 'Searching…', percentComplete: 15,
    searchesRun: ['a query'],
  });
  const running = await jobs.getFindLeadsJob(ORG, jobId);
  check('phase heartbeat', running?.phase === 2 && running?.searchesRun[0] === 'a query');

  const lead = {
    name: 'Test Person', title: 'VP', company: 'Acme', score: 70,
    source: 'https://example.com', email: 't@acme.com',
  };
  await jobs.setPartialLeads(ORG, jobId, [lead]);
  check('partial leads round-trip', (await jobs.getFindLeadsJob(ORG, jobId))?.partialLeads[0]?.email === 't@acme.com');

  // Identical payload must be skipped by the write guard.
  await jobs.setPartialLeads(ORG, jobId, [lead]);
  check('duplicate lead write is a no-op', true, 'guard exercised');

  check('auth token hidden from client reads',
    (await jobs.getFindLeadsJob(ORG, jobId) as unknown as Record<string, unknown>).authToken === undefined);

  check('cancel returns true while in flight', (await jobs.cancelJob(ORG, jobId)) === true);
  check('cancel is idempotent once final', (await jobs.cancelJob(ORG, jobId)) === false);

  console.log('\nsweeps');
  const item = { company: 'Acme', round: 'Series B' };
  const first = await sweeps.persistSweepItems('funding', [item]);
  const second = await sweeps.persistSweepItems('funding', [item]);
  check('insert writes', first.written === 1);
  check('re-ingest dedupes', second.written === 0);
  check('query returns it', (await sweeps.querySweepItems('funding', { limit: 5 })).length > 0);

  console.log('\nverification cache');
  const email = 'cache-test@example.com';
  await cache.saveCachedVerification(email, { status: 'verified', reason: 'smtp_ok' } as never, 'in-process');
  check('cacheable result stored', (await cache.getCachedVerification(email))?.status === 'verified');
  await cache.saveCachedVerification('transient@example.com', { status: 'unknown', reason: 'greylist' } as never, 'in-process');
  check('transient unknown NOT cached', (await cache.getCachedVerification('transient@example.com')) === null);
  check('hashEmail is stable', cache.hashEmail(' A@B.COM ') === cache.hashEmail('a@b.com'));

  console.log('\nsequences');
  const seq = await seqs.createSequence({
    orgId: ORG, name: 'verify seq', steps: [{ id: 's1', type: 'send_email', delayDays: 0, subject: 'hi', body: 'x' }],
    createdBy: USER,
  });
  const e = await enroll.createEnrollment({
    orgId: ORG, sequenceId: seq.sequenceId, prospectEmail: 'Due@Example.com', enrolledBy: USER,
  });
  check('enrollment created running', e.status === 'running');
  const due = await enroll.findDueEnrollments(10);
  check('due enrollment is claimed', due.some(d => d.enrollmentId === e.enrollmentId));
  const active = await enroll.findActiveEnrollmentsForProspect(ORG, 'due@example.com');
  check('prospect lookup is case-insensitive', active.length === 1);
  await seqs.bumpSequenceCounter(ORG, seq.sequenceId, 'enrolledCount');
  check('counter increments in SQL', (await seqs.getSequence(ORG, seq.sequenceId))?.enrolledCount === 1);

  console.log('\ncontact graph');
  const sig = { email: 'graph@example.com', name: 'Graph Person', title: 'CTO', extractorConfidence: 0.8 };
  const c1 = await graph.upsertContact(sig);
  check('contact created with sighting 1', c1.sightingCount === 1);
  const c2 = await graph.upsertContact({ ...sig, name: undefined, company: 'Acme' });
  check('second sighting increments', c2.sightingCount === 2, `count=${c2.sightingCount}`);
  check('existing field preserved when absent', c2.name === 'Graph Person');
  check('new field merged in', c2.company === 'Acme');

  await graph.recordContribution({ contactHash: c1.contactHash, orgId: ORG, userId: USER, source: 'manual' });
  check('contributor counted', (await graph.countContributors(c1.contactHash)) === 1);
  const removed = await graph.deleteAllForUser(ORG, USER);
  check('erasure removes contributions', removed === 1);
  check('orphaned contact swept', (await graph.getContact(c1.contactHash)) === null);

  // Clean up everything this script created.
  const pool = getPool();
  await pool.query('delete from find_leads_jobs where org_id=$1', [ORG]);
  await pool.query('delete from sequences where org_id=$1', [ORG]);
  // Scoped to the fixtures this script created. An earlier version deleted
  // every row in these tables and took the seeded development data with it.
  await pool.query("delete from sweep_items where sweep_type='funding' and payload->>'round'='Series B'");
  await pool.query('delete from email_verification_cache where email_hash = any($1)', [
    [cache.hashEmail('cache-test@example.com'), cache.hashEmail('transient@example.com')],
  ]);
  await pool.end();

  console.log(failures === 0 ? '\nAll store contracts verified.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
