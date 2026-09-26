import crypto from 'crypto';

/** One data model file, as wechart wrote it. */
export interface SnapshotFile {
  path: string;
  content: string;
}

/**
 * A model id: one wechart instance's whole model (`dev`, `demo`, a Helm
 * release name).
 */
export const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * ASCII segments, none of them `..`, ending in a kind Cube's file repository
 * reads. Being ASCII, a JavaScript sort of these is byte order, the order
 * wechart lists its files in.
 */
export const FILE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:ya?ml|js|jinja|py)$/;

export const MAX_PATH_LENGTH = 512;

/** Cube renders a YAML file holding any of these as Jinja (DataSchemaCompiler's JINJA_SYNTAX). */
export const JINJA_SYNTAX = /{%|%}|{{|}}/;

export interface SnapshotLimits {
  /** UTF-8 bytes of all contents together. */
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  /**
   * `yaml`: plain YAML only. `all` also takes JavaScript, Jinja and Python,
   * which Cube runs as code in its own process: whoever may import a
   * snapshot may then run code in Cube.
   */
  fileTypes: 'yaml' | 'all';
}

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxFiles: 10000,
  fileTypes: 'yaml',
};

export class SnapshotError extends Error {
  public constructor(
    public readonly status: 400 | 413,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sortedByPath(files: SnapshotFile[]): SnapshotFile[] {
  return [...files].sort((a, b) => {
    if (a.path === b.path) {
      return 0;
    }
    return a.path < b.path ? -1 : 1;
  });
}

/**
 * The files sorted by path, after checking every path and the limits.
 *
 * @throws SnapshotError
 */
export function checkedSnapshot(files: SnapshotFile[], limits: SnapshotLimits = DEFAULT_LIMITS): SnapshotFile[] {
  if (files.length > limits.maxFiles) {
    throw new SnapshotError(413, 'too_large', `A snapshot holds at most ${limits.maxFiles} files`);
  }

  const seen = new Set<string>();
  let bytes = 0;

  for (const { path, content } of files) {
    if (path.length > MAX_PATH_LENGTH || !FILE_PATH.test(path)) {
      throw new SnapshotError(400, 'invalid_path', `Invalid file path: ${JSON.stringify(path.slice(0, MAX_PATH_LENGTH))}`);
    }
    if (seen.has(path)) {
      throw new SnapshotError(400, 'duplicate_path', `Duplicate file path: ${path}`);
    }
    if (limits.fileTypes === 'yaml' && (!/\.ya?ml$/.test(path) || JINJA_SYNTAX.test(content))) {
      throw new SnapshotError(
        400,
        'invalid_file_type',
        `${path}: only plain YAML models are taken (no JavaScript, Python or Jinja)`,
      );
    }
    seen.add(path);

    const size = Buffer.byteLength(content, 'utf8');
    if (size > limits.maxFileBytes) {
      throw new SnapshotError(413, 'too_large', `${path} is larger than ${limits.maxFileBytes} bytes`);
    }
    bytes += size;
  }

  if (bytes > limits.maxBytes) {
    throw new SnapshotError(413, 'too_large', `A snapshot holds at most ${limits.maxBytes} bytes of content`);
  }

  return sortedByPath(files);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The snapshot's identity: the SHA-256 of its files, sorted by path, as the
 * JSON `[{"fileName": path, "content": content}, …]`. wechart computes the
 * same over its published files (its version is the first 16 characters),
 * so either side can tell whether the other holds the same model.
 */
export function contentHash(files: SnapshotFile[]): string {
  return sha256(JSON.stringify(sortedByPath(files).map(({ path, content }) => ({ fileName: path, content }))));
}

/** A file's content is stored once, under this. */
export function fileHash(content: string): string {
  return sha256(content);
}

export function snapshotBytes(files: SnapshotFile[]): number {
  return files.reduce((sum, { content }) => sum + Buffer.byteLength(content, 'utf8'), 0);
}
