/**
 * The JVM xcube's JDBC data sources run on (Db2 so far), and the vendor jars
 * it loads.
 *
 * The jars are mounted, never fetched: `XCUBE_JDBC_DRIVERS_DIR` holds one
 * directory per type (`db2/`), each with that type's `*.jar`. They are read
 * once, before the JVM starts; every jar found, with xcube's helper jar, is
 * the classpath. A type is available when one of its jars holds its driver
 * class; otherwise a connection, test, run or export on it is refused
 * (`DriverUnavailableError`, `driver_unavailable`), and the reason names the
 * type and the directory, never what is in it.
 *
 * The JVM starts only when the first JDBC connection opens: a deployment
 * that opens none has no JVM. Its options are xcube's alone, none from a data
 * source: its heap (`XCUBE_JDBC_MAX_HEAP_MB`), UTC as its zone, no signal
 * handlers of its own (Node's stay), and no file written but under the
 * temporary directory. `XCUBE_JDBC_TRUST_STORE` names a PEM bundle the JVM
 * trusts beside its own CAs, for a driver that reads only the JVM's.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The JDBC types xcube takes, each its directory under `XCUBE_JDBC_DRIVERS_DIR` and its driver class. */
export const JDBC_TYPES = {
  db2: { dir: 'db2', driverClass: 'com.ibm.db2.jcc.DB2Driver' },
} as const;

export type JdbcType = keyof typeof JDBC_TYPES;

export const isJdbcType = (type: unknown): type is JdbcType => typeof type === 'string' && Object.prototype.hasOwnProperty.call(JDBC_TYPES, type);

/** A JDBC type this deployment can't connect: its jar isn't mounted, or holds no driver class. */
export class DriverUnavailableError extends Error {
  public readonly code = 'driver_unavailable';

  public constructor(public readonly type: string, message: string) {
    super(message);
    this.name = 'DriverUnavailableError';
  }
}

export interface JarFound {
  type: JdbcType;
  file: string;
  size: number;
  sha256: string;
  /** Whether it holds its type's driver class. */
  provides: boolean;
}

export interface JdbcDrivers {
  /** Where they were read from: `null` when `XCUBE_JDBC_DRIVERS_DIR` is unset. */
  dir: string | null;
  jars: JarFound[];
  /** Why each type isn't available; a type without an entry is. */
  unavailable: Partial<Record<JdbcType, string>>;
}

/** A zip's entry names, from its central directory: `null` when it isn't a zip xcube can read. */
export function zipEntries(buffer: Buffer): string[] | null {
  // The end of central directory record: 22 bytes and a comment of up to 65,535.
  const from = Math.max(0, buffer.length - 22 - 65535);
  let end = -1;
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return null;
  }
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const offset = buffer.readUInt32LE(end + 16);
  // Zip64 (a count or offset at its maximum) isn't read: no driver jar is one.
  if (count === 0xffff || offset === 0xffffffff || offset + size > end) {
    return null;
  }
  const names: string[] = [];
  let at = offset;
  for (let k = 0; k < count; k++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) {
      return null;
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
  }
  return names;
}

/**
 * Reads the drivers' directory: each type's jars, their sizes and digests,
 * and whether one holds the type's driver class. Nothing in it stops xcube
 * starting: a type whose directory is missing, empty, or holds no jar with
 * its class is only unavailable.
 */
export function readJdbcDrivers(dir: string | undefined = process.env.XCUBE_JDBC_DRIVERS_DIR): JdbcDrivers {
  const jars: JarFound[] = [];
  const unavailable: Partial<Record<JdbcType, string>> = {};
  const root = dir === undefined || dir.trim() === '' ? null : dir;
  for (const type of Object.keys(JDBC_TYPES) as JdbcType[]) {
    const { dir: sub, driverClass } = JDBC_TYPES[type];
    if (root === null) {
      unavailable[type] = `No driver jar is mounted for ${type}: this deployment sets no XCUBE_JDBC_DRIVERS_DIR`;
    } else {
      const where = path.join(root, sub);
      let files: string[] = [];
      try {
        files = fs.readdirSync(where).filter((f) => f.toLowerCase().endsWith('.jar')).sort();
      } catch {
        files = [];
      }
      const entry = `${driverClass.replace(/\./g, '/')}.class`;
      for (const file of files) {
        const full = path.join(where, file);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            const bytes = fs.readFileSync(full);
            jars.push({
              type,
              file: full,
              size: stat.size,
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
              provides: Boolean(zipEntries(bytes)?.includes(entry)),
            });
          }
        } catch {
          // Unreadable: not on the classpath.
        }
      }
      if (!jars.some((j) => j.type === type && j.provides)) {
        unavailable[type] = files.length
          ? `No jar in ${where} holds ${driverClass}, the ${type} driver`
          : `No driver jar is mounted for ${type}: ${where} holds no .jar`;
      }
    }
  }
  return { dir: root, jars, unavailable };
}

let drivers: JdbcDrivers | null = null;

/** The drivers' directory as read once, at the first ask (before the JVM starts). */
export function jdbcDrivers(): JdbcDrivers {
  drivers ??= readJdbcDrivers();
  return drivers;
}

/** Forgets what was read: tests only. */
export function resetJdbcDrivers(read: JdbcDrivers | null = null) {
  drivers = read;
}

/** Why a JDBC type can't connect here, or `null` when it can. */
export function jdbcUnavailable(type: JdbcType): string | null {
  return jdbcDrivers().unavailable[type] ?? null;
}

/** Throws `DriverUnavailableError` for a JDBC type this deployment can't connect. */
export function assertJdbcAvailable(type: string) {
  if (isJdbcType(type)) {
    const reason = jdbcUnavailable(type);
    if (reason) {
      throw new DriverUnavailableError(type, reason);
    }
  }
}

/** Logs each jar found, by name, size and SHA-256: once, at start. */
export function logJdbcDrivers(log: (message: string, params: Record<string, unknown>) => void) {
  const read = jdbcDrivers();
  for (const jar of read.jars) {
    log('xcube: jdbc driver jar', {
      type: jar.type, file: path.basename(jar.file), size: jar.size, sha256: jar.sha256, providesDriver: jar.provides,
    });
  }
  for (const [type, reason] of Object.entries(read.unavailable)) {
    log('xcube: jdbc driver unavailable', { type, reason });
  }
}

/** xcube's helper jar: beside the package's `dist`, or where `XCUBE_JDBC_HELPER_JAR` says. */
export function helperJar(): string {
  return process.env.XCUBE_JDBC_HELPER_JAR ?? path.resolve(__dirname, '../../../jdbc/xcube-jdbc.jar');
}

/** The JVM's options: xcube's alone. */
export function jvmOptions(env: NodeJS.ProcessEnv = process.env): string[] {
  const heap = Number(env.XCUBE_JDBC_MAX_HEAP_MB ?? 512);
  if (!Number.isInteger(heap) || heap < 64 || heap > 65536) {
    throw new Error(`XCUBE_JDBC_MAX_HEAP_MB must be a whole number of megabytes from 64 to 65536, not ${JSON.stringify(env.XCUBE_JDBC_MAX_HEAP_MB)}`);
  }
  return [
    `-Xmx${heap}m`,
    // Node keeps its own signal handlers (SIGTERM's graceful shutdown among them).
    '-Xrs',
    // Every wall time read as the database holds it: nothing moved by the JVM's zone.
    '-Duser.timezone=UTC',
    '-Dfile.encoding=UTF8',
    '-Djava.awt.headless=true',
    // A read-only root file system: nothing written but under the temporary directory, and no perf file.
    `-Djava.io.tmpdir=${os.tmpdir()}`,
    '-XX:-UsePerfData',
  ];
}

/** node-java, once its JVM is up: the one instance in the process. */
let started: Promise<any> | null = null;

/** Whether the JVM was created: it can't be again, nor its options changed. */
let created = false;

/**
 * The JVM, started at the first call: the classpath is xcube's helper and
 * every vendor jar found, and the trust store, if any, is installed before
 * any connection opens. A failure to start is the call's, and the next tries
 * again only if node-java never created the JVM.
 */
export function jvm(): Promise<any> {
  if (!started) {
    started = (async () => {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const java = require('java');
      if (!java.isJvmCreated()) {
        java.options.push(...jvmOptions());
        java.classpath.push(helperJar(), ...jdbcDrivers().jars.map((j) => j.file));
        java.asyncOptions = {
          syncSuffix: 'Sync',
          asyncSuffix: undefined,
          promiseSuffix: 'P',
          // eslint-disable-next-line global-require
          promisify: require('util').promisify,
        };
        await new Promise<void>((resolve, reject) => {
          java.ensureJvm((e: unknown) => (e ? reject(e) : resolve()));
        });
        created = true;
        const store = process.env.XCUBE_JDBC_TRUST_STORE;
        if (store) {
          try {
            java.callStaticMethodSync('xcube.jdbc.Jdbc', 'trust', fs.readFileSync(store, 'ascii'));
          } catch (e: any) {
            // Kept: every JDBC connection fails so, never one made without the deployment's CAs.
            const cause = e?.code ?? String(e?.cause?.getMessageSync?.() ?? e?.message ?? 'error').split('\n')[0];
            const failed = new Error(`XCUBE_JDBC_TRUST_STORE can't be installed: ${cause}`);
            started = Promise.reject(failed);
            started.catch(() => undefined);
            throw failed;
          }
        }
      }
      return java;
    })();
    // Before the JVM exists a failure may pass (node-java not loading yet): the next call tries again.
    const attempt = started;
    attempt.catch(() => {
      if (started === attempt && !created) {
        started = null;
      }
    });
  }
  return started;
}
