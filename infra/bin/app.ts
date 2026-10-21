#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';
import { CronStack } from '../lib/cron-stack';

/**
 * Infrastructure entry point.
 *
 * Four stacks, deployed in order: Auth, Data, App, Cron. The dependency is
 * real — App needs the Cognito ids and the database, Cron needs the service
 * URL and the shared secret — and CDK infers it from the references between
 * them.
 *
 * Cron is deliberately part of `--all`. A schedule stack that has to be named
 * explicitly is one that gets left out of a deploy, and then the sweeps
 * silently never run.
 *
 * Configure with context, not edits:
 *   cdk deploy --all -c env=prod -c imageTag=$GITHUB_SHA
 *   cdk deploy --all -c env=dev  -c skipDatabase=true
 */

const app = new cdk.App();

const env = (app.node.tryGetContext('env') as string) ?? 'dev';
const prefix = env === 'prod' ? 'prospecting' : `prospecting-${env}`;
const imageTag = (app.node.tryGetContext('imageTag') as string) ?? 'latest';
const skipDatabase = app.node.tryGetContext('skipDatabase') === 'true';
const isProd = env === 'prod';

const awsEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
};

const tags = { Project: 'prospecting', Environment: env, ManagedBy: 'cdk' };

const auth = new AuthStack(app, `${prefix}-auth`, {
  env: awsEnv,
  prefix,
  // A destroyed user pool takes every account with it and cannot be restored.
  retainOnDelete: isProd,
  tags,
  description: 'Cognito user pool and the trigger that assigns custom:org_id',
});

const data = new DataStack(app, `${prefix}-data`, {
  env: awsEnv,
  prefix,
  skipDatabase,
  retainOnDelete: isProd,
  tags,
  description: 'Postgres, its VPC, and the generated credential secret',
});

const application = new AppStack(app, `${prefix}-app`, {
  env: awsEnv,
  prefix,
  vpc: data.vpc,
  database: data.database,
  databaseSecret: data.databaseSecret,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  imageTag,
  tags,
  description: 'ECR repository and the App Runner service',
});
application.addStackDependency(auth);
application.addStackDependency(data);

const cron = new CronStack(app, `${prefix}-cron`, {
  env: awsEnv,
  prefix,
  appUrl: `https://${application.service.attrServiceUrl}`,
  cronSecret: application.cronSecret,
  tags,
  description: 'EventBridge schedules for the sweeps, sequence runner and reaper',
});
cron.addStackDependency(application);

app.synth();
