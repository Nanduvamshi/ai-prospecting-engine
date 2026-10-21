import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * The application: an ECR repository and an App Runner service that runs it.
 *
 * App Runner rather than Lambda for a specific reason. A find-leads run is an
 * unawaited promise inside a request handler — the HTTP response returns in
 * under a second while the eight-phase pipeline keeps working for up to three
 * minutes. Lambda freezes execution once the response is sent, so the run
 * would simply stop. App Runner keeps the event loop alive.
 *
 * That same property is why minimum instances is one. A scale-to-zero would
 * discard any run in flight, and while the reaper cron recovers the job record
 * so it does not sit at "running" forever, the work itself is lost.
 */
export interface AppStackProps extends cdk.StackProps {
  readonly prefix: string;
  /** Present unless the database is external. Drives the VPC connector. */
  readonly vpc?: ec2.IVpc;
  readonly databaseSecret?: secretsmanager.ISecret;
  readonly database?: rds.IDatabaseInstance;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  /** Image tag to deploy. CI passes the commit sha. */
  readonly imageTag?: string;
}

export class AppStack extends cdk.Stack {
  readonly repository: ecr.Repository;
  readonly service: apprunner.CfnService;
  readonly cronSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `${props.prefix}-app`,
      imageScanOnPush: true,
      // Images accumulate fast with per-commit tags; keep the last twenty.
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the 20 most recent images' }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Shared between the cron schedules and the application, which compares
    // it against the x-cron-secret header. Generated here so it exists in
    // exactly one place.
    this.cronSecret = new secretsmanager.Secret(this, 'CronSecret', {
      secretName: `${props.prefix}/cron-secret`,
      description: 'Shared secret for the x-cron-secret header on /api/cron/*',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    const appSecrets = new secretsmanager.Secret(this, 'AppSecrets', {
      secretName: `${props.prefix}/app`,
      description:
        'Provider API keys. Every one is optional — the engine self-skips what is unset.',
      generateSecretString: {
        // Seeded empty so the secret exists and can be granted; fill the
        // values in after deploy rather than putting keys in source.
        secretStringTemplate: JSON.stringify({
          ANTHROPIC_API_KEY: '',
          SERPAPI_API_KEY: '',
          BRIGHTDATA_API_TOKEN: '',
          APOLLO_API_KEY: '',
          CRUNCHBASE_API_KEY: '',
          GITHUB_TOKEN: '',
          BOUNCER_API_KEY: '',
        }),
        generateStringKey: 'unused',
      },
    });

    // Lets App Runner pull from a private ECR repository.
    const accessRole = new iam.Role(this, 'EcrAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppRunnerServicePolicyForECRAccess'),
      ],
    });

    // The role the running container assumes.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description: 'Runtime role for the prospecting service',
    });
    this.cronSecret.grantRead(instanceRole);
    appSecrets.grantRead(instanceRole);
    props.databaseSecret?.grantRead(instanceRole);

    // Only when a database was provisioned — an external managed Postgres is
    // reached over the public internet and needs no connector.
    let networkConfiguration: apprunner.CfnService.NetworkConfigurationProperty | undefined;
    if (props.vpc) {
      const connectorSg = new ec2.SecurityGroup(this, 'ConnectorSg', {
        vpc: props.vpc,
        description: 'App Runner VPC connector',
        allowAllOutbound: true,
      });

      const connector = new apprunner.CfnVpcConnector(this, 'VpcConnector', {
        vpcConnectorName: `${props.prefix}-connector`,
        subnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds,
        securityGroups: [connectorSg.securityGroupId],
      });

      networkConfiguration = {
        egressConfiguration: {
          egressType: 'VPC',
          vpcConnectorArn: connector.attrVpcConnectorArn,
        },
      };
    }

    const secretRef = (secret: secretsmanager.ISecret, key?: string) =>
      key ? `${secret.secretArn}:${key}::` : secret.secretArn;

    this.service = new apprunner.CfnService(this, 'Service', {
      serviceName: `${props.prefix}-app`,
      sourceConfiguration: {
        authenticationConfiguration: { accessRoleArn: accessRole.roleArn },
        // CI pushes an image and then triggers a deployment explicitly, so a
        // migration always runs before the new code does.
        autoDeploymentsEnabled: false,
        imageRepository: {
          imageIdentifier: `${this.repository.repositoryUri}:${props.imageTag ?? 'latest'}`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '3000',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'AUTH_MODE', value: 'cognito' },
              { name: 'COGNITO_USER_POOL_ID', value: props.userPoolId },
              { name: 'COGNITO_CLIENT_ID', value: props.userPoolClientId },
              { name: 'NEXT_PUBLIC_COGNITO_USER_POOL_ID', value: props.userPoolId },
              { name: 'NEXT_PUBLIC_COGNITO_CLIENT_ID', value: props.userPoolClientId },
              { name: 'NEXT_PUBLIC_COGNITO_REGION', value: this.region },
              { name: 'NEXT_PUBLIC_AUTH_MODE', value: 'cognito' },
              { name: 'BILLING_PROVIDER', value: 'noop' },
              { name: 'EMAIL_SENDER', value: 'log' },
              { name: 'AI_PROVIDER', value: 'anthropic' },
              // The database is in private subnets, so CI cannot reach it to
              // migrate. The container does it at boot instead, serialised by
              // a Postgres advisory lock so concurrent instances cannot race.
              { name: 'MIGRATE_ON_BOOT', value: 'true' },
              // A plain variable, not a secret reference: the application
              // needs the ARN itself so it can read the individual fields and
              // compose a connection string. Listing it under
              // runtimeEnvironmentSecrets would make App Runner resolve it and
              // inject the password in its place.
              ...(props.databaseSecret
                ? [{ name: 'DATABASE_SECRET_ARN', value: props.databaseSecret.secretArn }]
                : []),
            ],
            runtimeEnvironmentSecrets: [
              { name: 'CRON_SECRET', value: secretRef(this.cronSecret) },
              { name: 'ANTHROPIC_API_KEY', value: secretRef(appSecrets, 'ANTHROPIC_API_KEY') },
              { name: 'SERPAPI_API_KEY', value: secretRef(appSecrets, 'SERPAPI_API_KEY') },
              { name: 'BRIGHTDATA_API_TOKEN', value: secretRef(appSecrets, 'BRIGHTDATA_API_TOKEN') },
              { name: 'APOLLO_API_KEY', value: secretRef(appSecrets, 'APOLLO_API_KEY') },
              { name: 'CRUNCHBASE_API_KEY', value: secretRef(appSecrets, 'CRUNCHBASE_API_KEY') },
              { name: 'GITHUB_TOKEN', value: secretRef(appSecrets, 'GITHUB_TOKEN') },
              { name: 'BOUNCER_API_KEY', value: secretRef(appSecrets, 'BOUNCER_API_KEY') },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: '1 vCPU',
        memory: '2 GB',
        instanceRoleArn: instanceRole.roleArn,
      },
      ...(networkConfiguration ? { networkConfiguration } : {}),
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/api/health',
        interval: 20,
        timeout: 5,
        healthyThreshold: 1,
        // Three strikes rather than one: /api/health touches the database, and
        // a single slow query should not cycle the instance.
        unhealthyThreshold: 3,
      },
    });

    const scaling = new apprunner.CfnAutoScalingConfiguration(this, 'Scaling', {
      autoScalingConfigurationName: `${props.prefix}-scaling`,
      // Never zero: a scale-to-zero drops any pipeline run in flight.
      minSize: 1,
      maxSize: 3,
      maxConcurrency: 80,
    });
    this.service.autoScalingConfigurationArn = scaling.attrAutoScalingConfigurationArn;

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `https://${this.service.attrServiceUrl}`,
      description: 'Public URL. Cron schedules target this.',
    });
    new cdk.CfnOutput(this, 'RepositoryUri', { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'AppSecretsArn', {
      value: appSecrets.secretArn,
      description: 'Fill in provider API keys here after deploy.',
    });
  }
}
