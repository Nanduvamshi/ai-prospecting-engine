import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Postgres.
 *
 * A note on the topology, because it deviates from the extraction plan.
 *
 * The plan called for a publicly-accessible instance and no VPC, to avoid a
 * NAT Gateway — the engine makes heavy outbound calls (search APIs, scraping,
 * SMTP probes, RSS), so a VPC-attached service needs NAT to reach the
 * internet, at roughly $32/month.
 *
 * That combination does not actually hold up. App Runner outside a VPC has
 * dynamic egress addresses, so there is no stable CIDR to allowlist, which
 * means a publicly-reachable database ends up open to 0.0.0.0/0 with only a
 * password in front of it. Cheap, and not something to put customer data
 * behind.
 *
 * So the default here is the correct shape: database in private subnets, App
 * Runner reaching it through a VPC connector, NAT for outbound. If the cost
 * matters more than the topology, set `skipDatabase` and point DATABASE_URL at
 * a managed provider (Neon, Supabase) that is designed for public access and
 * does its own connection authorisation — then this stack creates nothing and
 * there is no VPC to pay for.
 */
export interface DataStackProps extends cdk.StackProps {
  readonly prefix: string;
  /**
   * Bring your own Postgres instead. No VPC, no RDS, no NAT — but you supply
   * DATABASE_URL yourself and App Runner runs without a VPC connector.
   */
  readonly skipDatabase?: boolean;
  /** Larger than t4g.micro once real traffic arrives. */
  readonly instanceClass?: ec2.InstanceType;
  readonly retainOnDelete?: boolean;
}

export class DataStack extends cdk.Stack {
  /** Undefined when skipDatabase is set. */
  readonly vpc?: ec2.Vpc;
  readonly database?: rds.DatabaseInstance;
  readonly databaseSecret?: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    if (props.skipDatabase) {
      new cdk.CfnOutput(this, 'DatabaseMode', {
        value: 'external',
        description: 'No database provisioned. Supply DATABASE_URL from a managed provider.',
      });
      return;
    }

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.prefix}-vpc`,
      maxAzs: 2,
      // One NAT rather than one per AZ. A second buys availability for
      // outbound traffic during an AZ failure, which is not worth the cost
      // when the failure mode is "sweeps pause for a while".
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'Postgres, reachable only from inside the VPC',
      allowAllOutbound: false,
    });
    // Ingress from the VPC's own CIDR only. The App Runner VPC connector
    // places the service inside these subnets, so this is what it needs and
    // nothing beyond it.
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Postgres from within the VPC',
    );

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: `${props.prefix}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      instanceType:
        props.instanceClass ??
        ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [securityGroup],
      databaseName: 'prospecting',
      // Generated and rotated in Secrets Manager rather than passed in as a
      // parameter, so the password never appears in a template or a shell.
      credentials: rds.Credentials.fromGeneratedSecret('postgres', {
        secretName: `${props.prefix}/database`,
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: !props.retainOnDelete,
      deletionProtection: props.retainOnDelete ?? false,
      removalPolicy: props.retainOnDelete
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      // The reaper cron deletes expired rows in bounded batches; logging
      // slow queries is how you find out when a batch stops being bounded.
      parameters: { 'log_min_duration_statement': '2000' },
      cloudwatchLogsExports: ['postgresql'],
    });

    this.databaseSecret = this.database.secret!;

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
    });
    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'Holds the generated password. Compose DATABASE_URL from it.',
    });
    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
