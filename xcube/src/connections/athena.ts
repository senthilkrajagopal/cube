/**
 * Cube's Athena driver, fenced to a connection's own fields. Cube's reads its
 * keys, role, region, workgroup, output location, database and export bucket
 * from its environment wherever a field is empty, and the AWS SDK under it
 * reads its region, credentials, endpoint and retry settings from `AWS_*`
 * variables and `~/.aws` whenever a request needs them. Here every one is
 * given: an access key signs in with the connection's key and reads no
 * `AWS_*` variable at all; the pod's role reads only the four EKS sets
 * (`podRoleCredentials`), never the SDK's default chain.
 */
import { readFile } from 'fs/promises';
import type { Athena } from '@aws-sdk/client-athena';
import type { AthenaDriver as CubeAthenaDriver } from '@cubejs-backend/athena-driver';
import { withoutEnv } from './env';

/** Cube's own default, in seconds: ten minutes. A SQL run's own clock stops its query sooner. */
const POLL_TIMEOUT_S = 600;

/** Cube's own default, in seconds, between polls of a query it runs (a rollup's build). */
const POLL_MAX_INTERVAL_S = 5;

/** How many databases the connection test lists: 20 pages of 50. */
const DATABASE_PAGES = 20;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/** An AWS service's regional endpoint, China's regions under their own domain. */
export const awsEndpoint = (service: string, region: string) => (
  `https://${service}.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`
);

/**
 * The SDK's settings it would otherwise load from `AWS_*` variables or the
 * shared config files, each as the SDK's own default (`standard` mode).
 */
export const sdkSettings = (region: string, endpoint: string) => ({
  region,
  endpoint,
  defaultsMode: 'standard' as const,
  maxAttempts: 3,
  retryMode: 'standard',
  useDualstackEndpoint: false,
  useFipsEndpoint: false,
  disableClockSkewCorrection: false,
  authSchemePreference: [] as string[],
  userAgentAppId: 'xcube',
  defaultUserAgentProvider: async () => [['xcube'] as [string]],
  requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 },
});

const xmlValue = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]
  ?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, '\'')
  .replace(/&amp;/g, '&');

/** EKS Pod Identity's agent, or the SDK's other places it takes a container's credentials from. */
const CONTAINER_HOSTS = new Set(['169.254.170.2', '169.254.170.23', '[fd00:ec2::23]', '127.0.0.1', 'localhost', '[::1]']);

async function webIdentityCredentials(roleArn: string, tokenFile: string, stsEndpoint: string): Promise<AwsCredentials> {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const response = await fetch(stsEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: roleArn,
      RoleSessionName: `xcube-${Date.now()}`,
      WebIdentityToken: token,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const xml = await response.text();
  const accessKeyId = xmlValue(xml, 'AccessKeyId');
  const secretAccessKey = xmlValue(xml, 'SecretAccessKey');
  if (!response.ok || !accessKeyId || !secretAccessKey) {
    const code = xmlValue(xml, 'Code') ?? `HTTP ${response.status}`;
    throw new Error(`Taking the pod's role (${roleArn}) failed: ${code}: ${xmlValue(xml, 'Message') ?? 'no credentials in STS\'s answer'}`);
  }
  const expiration = xmlValue(xml, 'Expiration');
  return { accessKeyId, secretAccessKey, sessionToken: xmlValue(xml, 'SessionToken'), expiration: expiration ? new Date(expiration) : undefined };
}

async function containerCredentials(uri: string, authorizationFile: string | undefined): Promise<AwsCredentials> {
  const url = new URL(uri);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && CONTAINER_HOSTS.has(url.hostname))) {
    throw new Error('AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or the EKS Pod Identity agent\'s or a loopback address');
  }
  const authorization = authorizationFile ? (await readFile(authorizationFile, 'utf8')).trim() : undefined;
  const response = await fetch(url, {
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(10000),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || !body.AccessKeyId || !body.SecretAccessKey) {
    throw new Error(`Taking the pod's role from EKS Pod Identity failed: HTTP ${response.status}${body.Message ? `: ${body.Message}` : ''}`);
  }
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
    expiration: body.Expiration ? new Date(body.Expiration) : undefined,
  };
}

/**
 * The Cube pods' own role, from the only two places EKS gives it: IRSA's
 * role and token file (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`),
 * exchanged at the region's STS, or EKS Pod Identity's agent
 * (`AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`).
 * Nothing else is read: no keys, profiles or instance metadata. The SDK
 * keeps what it answers until shortly before it expires.
 */
export function podRoleCredentials(region: string, stsEndpoint = awsEndpoint('sts', region)): () => Promise<AwsCredentials> {
  return async () => {
    const {
      AWS_ROLE_ARN: roleArn,
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: containerUri,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: authorizationFile,
    } = process.env;
    if (roleArn && tokenFile) {
      return webIdentityCredentials(roleArn, tokenFile, stsEndpoint);
    }
    if (containerUri) {
      return containerCredentials(containerUri, authorizationFile);
    }
    throw new Error('The Cube pods have no role of their own: neither IRSA (AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE) '
      + 'nor EKS Pod Identity (AWS_CONTAINER_CREDENTIALS_FULL_URI) is set');
  };
}

/** What Cube's driver holds and its typings call private: its settings and its SDK client. */
export interface AthenaInternals {
  config: Record<string, any> & { workGroup: string; catalog?: string; database?: string; S3OutputLocation?: string };
  athena: Athena;
}

export const athenaInternals = (driver: object) => driver as unknown as AthenaInternals;

let driverClass: (new (config: Record<string, unknown>) => CubeAthenaDriver) | undefined;

function athenaDriverClass() {
  if (!driverClass) {
    // Loaded on first use, as Cube loads a driver: the image lays it beside Cube's own packages.
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { AthenaDriver } = require('@cubejs-backend/athena-driver') as typeof import('@cubejs-backend/athena-driver');

    class XcubeAthenaDriver extends AthenaDriver {
      public constructor(config: Record<string, any>) {
        super(config);
        const own = athenaInternals(this);
        // The stand-in database went where the connection names none (`makeAthenaDriver`).
        own.config.database = config.database;
        Reflect.set(this, 'schema', config.database);
        // It reads `AWS_LAMBDA_FUNCTION_NAME` on every request, for a header only Lambda sends.
        own.athena.middlewareStack.remove('recursionDetectionMiddleware');
      }

      // No export bucket: Cube's would UNLOAD the rollup's rows to S3.
      public override async isUnloadSupported() {
        return false;
      }

      /** The connection test's connect step (AC-1031): the workgroup, which must be on to run a query. */
      public override async testConnection() {
        const { athena, config } = athenaInternals(this);
        const { WorkGroup } = await athena.getWorkGroup({ WorkGroup: config.workGroup });
        if (WorkGroup?.State && WorkGroup.State !== 'ENABLED') {
          throw new Error(`The workgroup ${config.workGroup} is ${WorkGroup.State.toLowerCase()}`);
        }
      }

      /**
       * The connection test's catalog read (AC-1031): the catalog's databases,
       * from Athena's own catalog API (no query, so nothing scanned), and the
       * named one, which must be among them.
       */
      public override async getSchemas() {
        const { athena, config: { catalog, database } } = athenaInternals(this);
        const names: string[] = [];
        let NextToken: string | undefined;
        for (let page = 0; page < DATABASE_PAGES; page++) {
          const answer = await athena.listDatabases({ CatalogName: catalog, MaxResults: 50, NextToken });
          names.push(...(answer.DatabaseList ?? []).map((d) => String(d.Name)));
          NextToken = answer.NextToken;
          if (!NextToken) {
            break;
          }
        }
        if (database && !names.includes(database)) {
          await athena.getDatabase({ CatalogName: catalog, DatabaseName: database });
        }
        return names.map((name) => ({ schema_name: name }));
      }

      public override async release() {
        athenaInternals(this).athena.destroy();
      }
    }
    driverClass = XcubeAthenaDriver as any;
  }
  return driverClass!;
}

/**
 * An Athena driver from a connection's config (`DRIVERS.athena.config`): its
 * key, or the pod's role (`podRole`). `endpoint` and `stsEndpoint` are a
 * test's: a connection has neither.
 */
export function makeAthenaDriver(config: Record<string, unknown>): CubeAthenaDriver {
  const {
    accessKeyId, secretAccessKey, podRole, endpoint, stsEndpoint, ...rest
  } = config;
  const region = String(config.region);
  const credentials = podRole
    ? podRoleCredentials(region, stsEndpoint as string | undefined)
    : { accessKeyId: String(accessKeyId), secretAccessKey: String(secretAccessKey) };
  const DriverClass = athenaDriverClass();
  // Every AWS_ variable out of sight too: the SDK's client reads some as it is built.
  // Without a database, Cube's constructor reads the deprecated `CUBEJS_DB_SCHEMA`.
  return withoutEnv(['CUBEJS_', 'AWS_'], { CUBEJS_DB_NAME: '-' }, () => new DriverClass({
    ...rest,
    ...sdkSettings(region, (endpoint as string | undefined) ?? awsEndpoint('athena', region)),
    credentials,
    readOnly: true,
    exportBucket: undefined,
    pollTimeout: POLL_TIMEOUT_S,
    pollMaxInterval: POLL_MAX_INTERVAL_S,
  }));
}
