/**
 * Runs the find-leads pipeline from the command line.
 *
 * `package.json` referenced this script before it existed. It earns its place
 * because the pipeline is the one part of the system a store contract test
 * cannot cover — it needs a live LLM, a live search provider and a minute or
 * two of wall time. Driving it through the browser works but tells you little
 * when a phase misbehaves: the UI shows a label and a percentage, not which
 * query ran or why extraction came back empty.
 *
 *   npm run pipeline
 *   npm run pipeline -- --deep
 *   npm run pipeline -- --prompt "heads of sales at seed-stage fintechs in Bangalore"
 *   npm run pipeline -- --filters --titles "CTO" --industries saas --locations India
 *
 * This spends real money on whichever providers are configured.
 */
import 'dotenv/config';

import type { FindLeadsJobRequest } from '../src/server/pipeline/types';

const ORG = process.env.DEV_ORG_ID || 'dev-org';
const USER = process.env.DEV_USER_ID || 'dev-user';

const flag = (name: string) => process.argv.includes(`--${name}`);
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function buildRequest(): FindLeadsJobRequest {
  const searchDepth = flag('deep') ? 'deep' : 'quick';
  return flag('filters')
    ? {
        mode: 'filters',
        searchDepth,
        jobTitles: arg('titles', 'CTO, VP Engineering'),
        industries: arg('industries', 'saas').split(',').map((s) => s.trim()),
        locations: arg('locations', 'India'),
      }
    : {
        mode: 'ai',
        searchDepth,
        prompt: arg('prompt', 'Founders of early-stage B2B SaaS companies in India'),
      };
}

async function main() {
  const { createFindLeadsJob, getFindLeadsJob } = await import('../src/server/pipeline/jobs');
  const { runFindLeadsJob } = await import('../src/server/pipeline/find-leads-runner');
  const { getPool } = await import('../src/server/db/client');

  const request = buildRequest();
  const jobId = `cli_${Date.now()}`;
  const now = new Date().toISOString();

  const ai = [
    process.env.ANTHROPIC_API_KEY && 'anthropic',
    process.env.OPENAI_API_KEY && 'openai',
    process.env.AI_BEDROCK_ENABLED === 'true' && 'bedrock',
  ].filter(Boolean);
  console.log(`\n  ai=[${ai.join(', ') || 'none'}]  search=${process.env.SERPAPI_API_KEY ? 'serpapi' : 'duckduckgo'}`);
  const criteria =
    request.mode === 'ai'
      ? request.prompt
      : [request.jobTitles, request.industries?.join(', '), request.locations].filter(Boolean).join(' · ');
  console.log(`  ${request.mode}/${request.searchDepth}: ${criteria}\n`);

  await createFindLeadsJob({
    jobId,
    orgId: ORG,
    userId: USER,
    status: 'queued',
    phase: 0,
    phaseLabel: 'Getting ready…',
    percentComplete: 0,
    partialLeads: [],
    searchesRun: [],
    request,
    estimatedSeconds: request.searchDepth === 'deep' ? 150 : 60,
    createdAt: now,
    updatedAt: now,
  });

  // Poll alongside the run rather than reporting only at the end. The job
  // table exists so progress is observable while work is in flight, and a
  // phase that stalls — phase 7 verifies email patterns over SMTP and is by
  // far the slowest — is much easier to spot live than in a final summary.
  const startedAt = Date.now();
  let lastPhase = -1;
  let lastLeads = -1;
  const poll = setInterval(() => {
    void getFindLeadsJob(ORG, jobId)
      .then((job) => {
        if (!job) return;
        const t = `${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)}s`;
        if (job.phase !== lastPhase) {
          lastPhase = job.phase;
          console.log(`  ${t}  [${job.phase}/8] ${job.phaseLabel} (${job.percentComplete}%)`);
        }
        if (job.partialLeads.length !== lastLeads) {
          lastLeads = job.partialLeads.length;
          if (lastLeads > 0) console.log(`  ${t}         ${lastLeads} leads so far`);
        }
      })
      .catch(() => {});
  }, 2000);

  // The runner never throws: it writes failures onto the job record and
  // returns. Read the outcome back rather than relying on control flow.
  await runFindLeadsJob({
    jobId,
    orgId: ORG,
    userId: USER,
    authToken: '',
    // Mirror the no-op billing provider's large finite balance so budget
    // truncation behaves the same here as it does through the HTTP route.
    creditBalance: 1_000_000,
    request,
  });
  clearInterval(poll);

  const job = await getFindLeadsJob(ORG, jobId);
  console.log(`\n  ${job?.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (job?.status === 'failed') console.log(`  ${job.errorCode}: ${job.errorMessage}`);

  for (const q of job?.searchesRun ?? []) console.log(`    search: ${q}`);

  const leads = job?.partialLeads ?? [];
  console.log(`\n  ${leads.length} leads`);
  for (const l of leads) {
    console.log(
      `    ${String(l.score).padStart(3)}  ` +
        [l.name, l.title, l.company && `@ ${l.company}`, l.email && `<${l.email}>`, l.phone]
          .filter(Boolean)
          .join('  '),
    );
  }
  if (leads.length) console.log(`\n  ${leads.filter((l) => l.email).length}/${leads.length} with an email`);
  if (job?.metadata) console.log(`  ${JSON.stringify(job.metadata)}`);

  await getPool().end();
  process.exit(job?.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  crashed:', err);
  process.exit(1);
});
