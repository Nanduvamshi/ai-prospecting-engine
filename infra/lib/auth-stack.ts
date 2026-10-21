import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Identity.
 *
 * The application verifies a Cognito ID token and reads the organisation from
 * a `custom:org_id` claim. It does **not** fall back to a database lookup when
 * the claim is missing — that would mean a query on every request, and
 * leaving it out is deliberate.
 *
 * That makes the claim load-bearing: if nothing sets it at signup, every
 * request from a new user returns 403 with no obvious cause. The
 * post-confirmation trigger below is what prevents that, and it is the single
 * most important part of this stack.
 */
export interface AuthStackProps extends cdk.StackProps {
  /** Prefix for resource names, e.g. "prospecting" or "prospecting-uat". */
  readonly prefix: string;
  /** Retain the pool on stack deletion. True for anything user-facing. */
  readonly retainOnDelete?: boolean;
}

export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // An explicit log group rather than the `logRetention` shortcut, which is
    // deprecated because it provisioned a custom resource to set retention
    // after the fact.
    const triggerLogs = new logs.LogGroup(this, 'PostConfirmationLogs', {
      logGroupName: `/aws/lambda/${props.prefix}-post-confirmation`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const postConfirmation = new lambda.Function(this, 'PostConfirmation', {
      functionName: `${props.prefix}-post-confirmation`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: triggerLogs,
      code: lambda.Code.fromAsset('lambda/post-confirmation'),
      description:
        'Assigns custom:org_id after signup. Without it every authenticated request 403s.',
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        // Mutable so the trigger can write it after the account is confirmed,
        // and so a user can later be moved between organisations.
        org_id: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: true }),
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 32, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: { postConfirmation },
      removalPolicy: props.retainOnDelete
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // The trigger writes the custom attribute back onto the user that
    // triggered it, which needs an explicit grant.
    this.userPool.grant(postConfirmation, 'cognito-idp:AdminUpdateUserAttributes');
    postConfirmation.addEnvironment('USER_POOL_ID', this.userPool.userPoolId);

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${props.prefix}-web`,
      // No client secret: this is a browser client and a secret it ships
      // cannot be secret.
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: false },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
      // The application has its own /login page, so no hosted UI and no
      // OAuth flows to configure.
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true, fullname: true })
        .withCustomAttributes('org_id', 'role'),
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Set as COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_USER_POOL_ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Set as COGNITO_CLIENT_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID',
    });
  }
}
