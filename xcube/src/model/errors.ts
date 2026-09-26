import yaml from 'js-yaml';

import type { SnapshotFile } from './snapshot';

/** A problem with a snapshot, placed as well as Cube's message allows. */
export interface ModelError {
  /** `null` when Cube names no file, as for many semantic errors. */
  path: string | null;
  line?: number;
  column?: number;
  kind: 'yaml' | 'compile';
  message: string;
}

/** Cube renders a YAML file with Jinja first when it holds a Jinja tag. */
const JINJA = /{%|%}|{{|}}/;

/**
 * The YAML syntax errors of every plain YAML file. Cube stops at the first
 * YAML file it can't parse, so these are checked before compiling, which
 * reports them all, with their lines.
 */
export function yamlErrors(files: SnapshotFile[]): ModelError[] {
  const errors: ModelError[] = [];
  const plain = files.filter(({ path, content }) => /\.ya?ml$/.test(path) && !JINJA.test(content));
  for (const { path, content } of plain) {
    try {
      yaml.load(content, { filename: path });
    } catch (e: any) {
      if (!(e instanceof yaml.YAMLException)) {
        throw e;
      }
      errors.push({
        path,
        ...(e.mark ? { line: e.mark.line + 1, column: e.mark.column + 1 } : {}),
        kind: 'yaml',
        message: e.reason || e.message,
      });
    }
  }
  return errors;
}

/** The file defining each cube and view, where the files say it plainly. */
function definitions(files: SnapshotFile[]): Map<string, string> {
  const where = new Map<string, string>();
  for (const { path, content } of files) {
    if (/\.ya?ml$/.test(path) && !JINJA.test(content)) {
      try {
        const doc: any = yaml.load(content);
        for (const kind of ['cubes', 'views']) {
          for (const item of Array.isArray(doc?.[kind]) ? doc[kind] : []) {
            if (typeof item?.name === 'string' && !where.has(item.name)) {
              where.set(item.name, path);
            }
          }
        }
      } catch {
        // Reported by yamlErrors.
      }
    } else if (/\.js$/.test(path)) {
      for (const match of content.matchAll(/\b(?:cube|view)\s*\(\s*[`'"]([A-Za-z_]\w*)[`'"]/g)) {
        if (!where.has(match[1])) {
          where.set(match[1], path);
        }
      }
    }
  }
  return where;
}

/**
 * Cube names no file for many errors, but starts those about one cube or
 * view with its name (`orders cube: …`); those go to the file defining it.
 */
export function placeByName(errors: ModelError[], files: SnapshotFile[]): ModelError[] {
  if (!errors.some(({ path }) => path === null)) {
    return errors;
  }
  const where = definitions(files);
  return errors.map((error) => {
    if (error.path !== null) {
      return error;
    }
    const named = /^([A-Za-z_]\w*) (?:cube|view)\b/.exec(error.message);
    const path = named && where.get(named[1]);
    return path ? { ...error, path } : error;
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `<file> Errors:`, or `Errors:` for errors that name no file, as Cube groups them. */
const GROUP = /^(?:(\S+) )?Errors:$/;

/** A code frame's marked line: `> 12 | …`. */
const FRAME_LINE = /^\s*>\s*(\d+)\s*\|/;

/** A code frame's caret line: `     |     ^`. */
const FRAME_CARET = /^(\s*\|)(\s*)\^/;

/**
 * Cube's compile errors, one per message, from the text of its
 * `CompileError`: errors grouped under a line naming their file, each group
 * ending in a blank line. Lines come from a message's code frame, when it
 * has one. The paths are the snapshot's own, so only those are trusted.
 */
export function compileErrors(message: string, paths: ReadonlySet<string>): ModelError[] {
  const lines = message.replace(ANSI, '').split('\n');
  const errors: ModelError[] = [];
  let path: string | null = null;
  let inGroup = false;
  let last: ModelError | null = null;

  for (const line of lines) {
    const group = GROUP.exec(line.trim());
    const frame = FRAME_LINE.exec(line);
    const caret = FRAME_CARET.exec(line);

    if (group) {
      path = group[1] && paths.has(group[1]) ? group[1] : null;
      inGroup = true;
      last = null;
    } else if (!inGroup || /^Compile errors:$/.test(line.trim())) {
      // Before the first group.
    } else if (!line.trim()) {
      last = null;
    } else if (frame) {
      if (last && last.line === undefined) {
        last.line = Number(frame[1]);
      }
    } else if (caret) {
      if (last && last.column === undefined && last.line !== undefined) {
        last.column = caret[2].length;
      }
    } else if (!/^\s/.test(line) && !/^\s*\d+\s*\|/.test(line)) {
      // Anything else indented is the rest of a code frame, or a stack.
      last = { path, kind: 'compile', message: line.trim() };
      errors.push(last);
    }
  }

  return errors;
}
