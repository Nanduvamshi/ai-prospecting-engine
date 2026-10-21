import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Scheduled work.
 *
 * EventBridge Scheduler calling API Destinations, rather than the pattern the
 * original used — a forwarder Lambda holding the shared secret in an
 * environment variable and POSTing on a timer. No function to maintain, no
 * cold start, and the secret lives in a Connection rather than in code.
 *
 * One API Destination per schedule, each with a concrete URL. The tidier
 * shape would be a single wildcard destination with each schedule supplying
 * its own path, but that needs `HttpParameters` on the target, which
 * EventBridge *Rules* have and EventBridge *Scheduler* does not. Scheduler is
 * still the right service here — it brings flexible time windows, timezone
 * handling and a schedule group — and destinations are cheap, so eight of
 * them is a fair trade.
 *
 * `reap` is the odd one out among the schedules. It exists because
 * Postgres has no TTL: every table carrying an `expires_at` needs something to
 * delete from it. It also recovers pipeline runs whose instance was recycled
 * mid-flight, which would otherwise sit at "running" forever while the browser
 * polls them.
 */
export interface CronStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Base URL of the App Runner service, no trailing slash. */
  readonly appUrl: string;
  /** The same secret the application checks on x-cron-secret. */
  readonly cronSecret: secretsmanager.ISecret;
}

interface Schedule {
  /** Path segment under /api/cron, also used for resource naming. */
  readonly name: string;
  readonly expression: string;
  readonly description: string;
}

const SCHEDULES: Schedule[] = [
  {
    name: 'funding-sweep',
    expression: 'rate(1 hour)',
    description: 'Poll funding announcement feeds — a fresh round means budget arrived',
  },
  {
    name: 'social-sweep',
    expression: 'rate(4 hours)',
    description: 'Reddit and Hacker News for buying-intent questions',
  },
  {
    name: 'review-sweep',
    expression: 'cron(0 3 * * ? *)',
    description: 'Low-star competitor reviews with switching intent. Off-peak, because it scrapes',
  },
  {
    name: 'domain-sweep',
    expression: 'cron(0 4 * * ? *)',
    description: 'Newly issued certificates matching ICP keywords',
  },
  {
    name: 'sync-disposable-domains',
    expression: 'cron(0 5 * * ? *)',
    description: 'Refresh the disposable-email blocklist from upstream',
  },
  {
    name: 'public-data-sync',
    expression: 'cron(0 6 * * ? *)',
    description: 'Ingest public roles from SEC, GitHub, Crunchbase and job boards',
  },
  {
    name: 'sequence-runner',
    expression: 'rate(5 minutes)',
    description: 'Advance outreach enrollments whose next step is due',
  },
  {
    name: 'reap',
    expression: 'cron(30 2 * * ? *)',
    description: 'Delete expired rows and fail pipeline runs whose instance vanished',
  },
];

/** `funding-sweep` -> `FundingSweep`, for CDK construct ids. */
function toConstructId(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export class CronStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CronStackProps) {
    super(scope, id, props);

    // Holds the shared secret and injects it as a header on every call.
    const connection = new events.CfnConnection(this, 'Connection', {
      name: `${props.prefix}-cron`,
      authorizationType: 'API_KEY',
      description: 'Injects x-cron-secret on scheduled calls to /api/cron/*',
      authParameters: {
        apiKeyAuthParameters: {
          apiKeyName: 'x-cron-secret',
          // Renders as a CloudFormation dynamic reference
          // ({{resolve:secretsmanager:...}}), so the synthesised template
          // carries a pointer and CloudFormation substitutes the value at
          // deploy time — the literal secret is never written to the template
          // or to the CDK asset bundle.
          apiKeyValue: props.cronSecret.secretValue.unsafeUnwrap(),
        },
      },
    });

    const role = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler invoke the cron API destinations',
    });

    const group = new scheduler.CfnScheduleGroup(this, 'Group', {
      name: `${props.prefix}-cron`,
    });

    for (const s of SCHEDULES) {
      const constructId = toConstructId(s.name);

      const destination = new events.CfnApiDestination(this, `Destination${constructId}`, {
        name: `${props.prefix}-${s.name}`,
        connectionArn: connection.attrArn,
        invocationEndpoint: `${props.appUrl}/api/cron/${s.name}`,
        httpMethod: 'POST',
        // These endpoints do real work — scraping, LLM calls, batched deletes.
        // One invocation at a time is the intent; the ceiling is a guard
        // against a retry storm, not a throughput target.
        invocationRateLimitPerSecond: 1,
      });

      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['events:InvokeApiDestination'],
          resources: [destination.attrArn],
        }),
      );

      new scheduler.CfnSchedule(this, `Schedule${constructId}`, {
        name: `${props.prefix}-${s.name}`,
        groupName: group.name,
        description: s.description,
        scheduleExpression: s.expression,
        scheduleExpressionTimezone: 'UTC',
        // Periodic sweeps, not appointments — a slightly late run is fine and
        // spreading them avoids every schedule firing on the same second.
        flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 5 },
        state: 'ENABLED',
        target: {
          arn: destination.attrArn,
          roleArn: role.roleArn,
          input: JSON.stringify({ source: 'eventbridge-scheduler', schedule: s.name }),
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
        },
      });
    }

    new cdk.CfnOutput(this, 'ScheduleCount', { value: String(SCHEDULES.length) });
    new cdk.CfnOutput(this, 'ScheduleGroup', { value: `${props.prefix}-cron` });
  }
}
