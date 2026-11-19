import { once } from 'events';
import type { Response } from 'express';

/** How much JSON is gathered before one write. */
const WRITE_BYTES = 256 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && !Array.isArray(value) && typeof (value as any).toJSON !== 'function';

/**
 * `JSON.stringify(value)` as consecutive pieces whose concatenation is the
 * same text: the top object's members, and the entries of the arrays and
 * objects it holds, one at a time. No piece is larger than one of those
 * entries, so an answer may outgrow V8's longest string (about 512M
 * characters; `/v1/meta` of a model with thousands of wide cubes does).
 */
export function* jsonPieces(value: unknown, depth = 2): Generator<string> {
  if (depth <= 0 || !(Array.isArray(value) || isPlainObject(value))) {
    // As JSON.stringify writes an entry: undefined, a function or a symbol in an array is null.
    yield JSON.stringify(value) ?? 'null';
    return;
  }
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i) {
        yield ',';
      }
      yield* jsonPieces(value[i], depth - 1);
    }
    yield ']';
    return;
  }
  yield '{';
  let first = true;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    // As JSON.stringify leaves out a member it can't write.
    if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') {
      yield `${first ? '' : ','}${JSON.stringify(key)}:`;
      first = false;
      yield* jsonPieces(entry, depth - 1);
    }
  }
  yield '}';
}

/** Whether an answer is a meta answer: `/v1/meta`'s, `?extended`'s, or xcube's admin one. */
export function isMetaAnswer(body: unknown): boolean {
  return isPlainObject(body) && Array.isArray(body.cubes);
}

/** Writes the pieces in writes of about `WRITE_BYTES`, waiting for the socket to drain, then ends the answer. */
async function writePieces(res: Response, pieces: Iterable<string>): Promise<void> {
  let pending: string[] = [];
  let bytes = 0;
  const flush = async () => {
    const chunk = pending.join('');
    pending = [];
    bytes = 0;
    if (chunk && !res.write(chunk) && !res.destroyed) {
      await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
  };
  for (const piece of pieces) {
    if (res.destroyed) {
      return;
    }
    pending.push(piece);
    bytes += piece.length;
    if (bytes >= WRITE_BYTES) {
      await flush();
    }
  }
  await flush();
  res.end();
}

/**
 * Writes `body` as `res.json` would (same bytes, same content type), a piece
 * at a time and waiting for the socket to drain, so the whole JSON is never
 * one string.
 */
export async function writeJson(res: Response, body: unknown, status?: number): Promise<void> {
  if (status) {
    res.status(status);
  }
  if (!res.get('Content-Type')) {
    res.set('Content-Type', 'application/json; charset=utf-8');
  }
  await writePieces(res, jsonPieces(body));
}

/**
 * A meta answer as NDJSON: one line per cube or view, as `cubes` lists them,
 * then, when the answer has view groups, one last line `{"viewGroups":[…]}`
 * (a cube's line always has its `name`). The compiler id, a field of the
 * JSON answer, is the `x-xcube-compiler-id` header.
 */
export async function writeNdjson(res: Response, body: { cubes: unknown[]; viewGroups?: unknown[]; compilerId?: string }): Promise<void> {
  res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  if (typeof body.compilerId === 'string') {
    res.set('x-xcube-compiler-id', body.compilerId);
  }
  const groups = Array.isArray(body.viewGroups) && body.viewGroups.length ? [{ viewGroups: body.viewGroups }] : [];
  await writePieces(res, (function* lines() {
    for (const line of [...body.cubes, ...groups]) {
      yield `${JSON.stringify(line)}\n`;
    }
  }()));
}
