import 'server-only';

/**
 * Where the connection string comes from.
 *
 * Locally it is `DATABASE_URL` and that is the end of it. On AWS the database
 * password is generated into Secrets Manager and never written anywhere else,
 * so there is no URL to hand the container — only an ARN pointing at the
 * pieces. App Runner can inject a single secret value into an environment
 * variable but cannot compose one out of several, so assembling the URL is the
 * application's job.
 *
 * Resolved once and cached: this runs on the first database call, and the
 * value does not change for the life of the process.
 */

interface RdsSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname?: string;
  engine?: string;
}

let cached: string | null = null;

async function fromSecretsManager(secretArn: string): Promise<string> {
  // Imported lazily so the AWS SDK is never loaded in local development,
  // where this path is not taken.
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  const region = secretArn.split(':')[3];
  const client = new SecretsManagerClient(region ? { region } : {});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));

  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }

  const secret = JSON.parse(response.SecretString) as RdsSecret;
  const database = process.env.DATABASE_NAME ?? secret.dbname ?? 'prospecting';

  // Encoded because a generated password can legitimately contain characters
  // that would otherwise terminate the URL early.
  const user = encodeURIComponent(secret.username);
  const password = encodeURIComponent(secret.password);

  return `postgres://${user}:${password}@${secret.host}:${secret.port}/${database}?sslmode=require`;
}

export async function resolveConnectionString(): Promise<string> {
  if (cached) return cached;

  const direct = process.env.DATABASE_URL;
  if (direct && direct.trim() !== '') {
    cached = direct;
    return cached;
  }

  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (secretArn && secretArn.trim() !== '') {
    cached = await fromSecretsManager(secretArn);
    return cached;
  }

  throw new Error(
    'No database configured. Set DATABASE_URL, or DATABASE_SECRET_ARN pointing at an ' +
      'RDS-style secret. See .env.example.',
  );
}

/**
 * The synchronous form, for callers that cannot await.
 *
 * Only works when DATABASE_URL is set directly. Returns null when the string
 * has to be fetched, so the caller can fall back to the async path.
 */
export function connectionStringSync(): string | null {
  if (cached) return cached;
  const direct = process.env.DATABASE_URL;
  return direct && direct.trim() !== '' ? direct : null;
}
