import { DEFAULT_LIMITS, type SnapshotLimits } from '../model/snapshot';
import { assertSchemaName } from '../store/db';

/** xcube's runtime settings, from `XCUBE_*`. */
export interface XcubeSettings {
  databaseUrl: string;
  /** Schema of xcube's tables, and prefix of its notification channel. */
  schema: string;
  /** `false` only checks the schema is up to date. */
  migrate: boolean;
  /** How often every model's current revision is re-read, as a backstop to notifications. */
  pollIntervalMs: number;
  /** The poll while the notification listener is down. */
  pollIntervalDownMs: number;
  /** How long a replaced revision stays compiled, for requests that pinned it. */
  retireGraceMs: number;
  /** Revisions kept per model. */
  keepRevisions: number;
  limits: SnapshotLimits;
  /** Imports and dry runs that may wait for the compile lane. */
  compileQueue: number;
  compileWaitMs: number;
  /** How long a request naming a newer revision may wait for this instance to switch to it. */
  catchUpMs: number;
  /** Bearer tokens the admin routes accept. */
  adminTokens: string[];
  /** Most models one process keeps state for; a model beyond it is refused. */
  maxModels: number;
  /** Module packing: groups smaller than `packMin` items are packed into modules of at most `packMax`. */
  modules: { packMin: number; packMax: number };
  /** `DEFAULT_TOKENS` when absent. */
  tokens?: TokenSettings;
}

/** How tokens are verified: RS256 user tokens against each model's pushed keys, service tokens against configured ones. */
export interface TokenSettings {
  /** The `aud` a user token names. */
  audience: string;
  /** The `aud` a service token names. */
  serviceAudience: string;
  /** When set, the `iss` a service token names. */
  serviceIssuer?: string;
  /** Clock skew allowed on `exp`, `iat` and `nbf`, in seconds. */
  clockToleranceS: number;
  /** The longest a token may live (`exp - iat`), in seconds. */
  maxLifetimeS: number;
  /**
   * Tokens signed with Cube's API secret (HS256): taken for a model until it
   * has keys (`until-keys`), or never (`off`).
   */
  hs256: 'until-keys' | 'off';
  /** The service credential's public keys: a JWK set, or PEM public keys or certificates. */
  serviceKeys: string;
  /** A file holding them instead, re-read when it changes (a mounted Secret). */
  serviceKeysFile?: string;
}

export const DEFAULT_TOKENS: TokenSettings = {
  audience: 'xcube',
  serviceAudience: 'xcube-admin',
  clockToleranceS: 60,
  maxLifetimeS: 3600,
  hs256: 'until-keys',
  serviceKeys: '',
};

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

function hs256(raw: string | undefined): 'until-keys' | 'off' {
  const value = (raw || 'until-keys').toLowerCase();
  if (value !== 'until-keys' && value !== 'off') {
    throw new Error(`XCUBE_HS256 is until-keys or off, not ${JSON.stringify(raw)}`);
  }
  return value;
}

function fileTypes(raw: string | undefined): 'yaml' | 'all' {
  const value = (raw || 'yaml').toLowerCase();
  if (value !== 'yaml' && value !== 'all') {
    throw new Error(`XCUBE_FILE_TYPES is yaml or all, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The settings, or `null` when `XCUBE_DATABASE_URL` is unset and xcube serves introspection only. */
export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): XcubeSettings | null {
  const databaseUrl = env.XCUBE_DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }

  const adminTokens = (env.XCUBE_ADMIN_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const token of adminTokens) {
    if (token.length < 32 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new Error('Each of XCUBE_ADMIN_TOKENS must be at least 32 characters of [A-Za-z0-9._~-]');
    }
    if (token === env.CUBEJS_API_SECRET) {
      throw new Error('XCUBE_ADMIN_TOKENS must not hold CUBEJS_API_SECRET');
    }
  }

  return {
    databaseUrl,
    schema: assertSchemaName(env.XCUBE_DATABASE_SCHEMA || 'xcube'),
    migrate: (env.XCUBE_MIGRATE || 'true').toLowerCase() !== 'false',
    pollIntervalMs: number(env, 'XCUBE_POLL_INTERVAL_MS', 60000),
    pollIntervalDownMs: number(env, 'XCUBE_POLL_INTERVAL_DOWN_MS', 10000),
    retireGraceMs: number(env, 'XCUBE_RETIRE_GRACE_MS', 5 * 60 * 1000),
    keepRevisions: Math.max(1, number(env, 'XCUBE_KEEP_REVISIONS', 50)),
    limits: {
      ...DEFAULT_LIMITS,
      maxBytes: number(env, 'XCUBE_MAX_SNAPSHOT_BYTES', DEFAULT_LIMITS.maxBytes),
      fileTypes: fileTypes(env.XCUBE_FILE_TYPES),
    },
    compileQueue: number(env, 'XCUBE_COMPILE_QUEUE', 4),
    compileWaitMs: number(env, 'XCUBE_COMPILE_WAIT_MS', 120000),
    catchUpMs: number(env, 'XCUBE_CATCH_UP_MS', 10000),
    adminTokens,
    maxModels: number(env, 'XCUBE_MAX_MODELS', 1000),
    modules: {
      packMin: number(env, 'XCUBE_MODULE_PACK_MIN', 50),
      packMax: Math.max(1, number(env, 'XCUBE_MODULE_PACK_MAX', 300)),
    },
    tokens: {
      audience: env.XCUBE_TOKEN_AUDIENCE || DEFAULT_TOKENS.audience,
      serviceAudience: env.XCUBE_SERVICE_AUDIENCE || DEFAULT_TOKENS.serviceAudience,
      serviceIssuer: env.XCUBE_SERVICE_ISSUER || undefined,
      clockToleranceS: number(env, 'XCUBE_TOKEN_CLOCK_TOLERANCE_S', DEFAULT_TOKENS.clockToleranceS),
      maxLifetimeS: Math.max(1, number(env, 'XCUBE_TOKEN_MAX_LIFETIME_S', DEFAULT_TOKENS.maxLifetimeS)),
      hs256: hs256(env.XCUBE_HS256),
      serviceKeys: env.XCUBE_SERVICE_KEYS || '',
      serviceKeysFile: env.XCUBE_SERVICE_KEYS_FILE || undefined,
    },
  };
}
