# Infrastructure

Four CDK stacks. Nothing here has been deployed.

```
auth   Cognito user pool + the trigger that assigns custom:org_id
data   VPC, Postgres in private subnets, generated credential secret
app    ECR repository + App Runner service
cron   8 EventBridge schedules calling API Destinations
```

## Deploying

```bash
cd infra
npm ci
npx cdk bootstrap                              # once per account/region
npx cdk deploy --all -c env=dev
```

`--all` includes `cron` on purpose. A schedule stack that has to be named
explicitly is one that gets left out of a deploy, and then the sweeps silently
never run.

After the first deploy, fill in the provider keys:

```bash
aws secretsmanager put-secret-value --secret-id prospecting-dev/app \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-...","SERPAPI_API_KEY":"..."}'
```

Only `ANTHROPIC_API_KEY` really matters — lead extraction is an LLM step, so
without it the pipeline stops at phase 4. Everything else self-skips.

## Two deliberate decisions

**The database is private, not public.** The plan called for a
publicly-accessible instance and no VPC, to avoid a NAT Gateway (~$32/month) —
the engine makes heavy outbound calls, so a VPC-attached service needs NAT to
reach the internet.

That does not hold up. App Runner outside a VPC has dynamic egress addresses,
so there is no stable CIDR to allowlist, and a publicly-reachable database ends
up open to `0.0.0.0/0` with only a password in front of it.

So: private subnets, a VPC connector, NAT for outbound. If the cost matters
more, `-c skipDatabase=true` provisions no database and no VPC — point
`DATABASE_URL` at a managed provider (Neon, Supabase) that is built for public
access and does its own connection authorisation.

**Migrations run at container boot, not from CI.** The plan said never at
startup, because concurrent instances would race. The reasoning is right; the
conclusion does not survive the topology, because a database in private subnets
is unreachable from a CI runner without a bastion, a tunnel, or a Lambda inside
the VPC.

Instead `src/instrumentation.ts` migrates behind a Postgres advisory lock,
which removes the race directly rather than avoiding it. One instance
acquires the lock and migrates; the others block, then find the work done.
Verified with three simultaneous starts against an empty database: 22 tables,
2 migration records, no duplication.

## Local verification without an AWS account

```bash
npx cdk synth -c env=dev      # renders templates, no credentials, no calls
```

Synth is environment-agnostic on purpose, so it works in CI as a validation
step. A real deploy resolves the account and region from your credentials.

## Cost, roughly

| | monthly |
|---|---|
| App Runner, 1 vCPU / 2 GB, min 1 instance | ~$25 |
| RDS `t4g.micro`, 20 GB | ~$15 |
| NAT Gateway | ~$32 + data |
| Secrets Manager, 3 secrets | ~$1.20 |
| EventBridge schedules, ECR | pennies |

Around **$75/month** idle. `-c skipDatabase=true` with an external Postgres
removes the RDS and NAT lines, taking it to roughly $30 plus whatever the
provider charges.
