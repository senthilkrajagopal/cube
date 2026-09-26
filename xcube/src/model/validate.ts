import { CompileLane, Priority } from '../runtime/lane';
import { compileErrors, placeByName, yamlErrors, type ModelError } from './errors';
import type { SnapshotFile } from './snapshot';

/** A query whose SQL a check generates, to see whether Cube refuses it. */
export interface Probe {
  id: string;
  query: unknown;
  /** Also ask the current revision, when the candidate refuses. */
  compare?: boolean;
}

export interface ProbeAnswer {
  /** 200, 400 for Cube's refusal, anything else for "couldn't be asked"; `null` when skipped. */
  status: number | null;
  error?: string;
  skipped?: string;
  revision?: number;
}

export interface ProbeResult {
  id: string;
  candidate: ProbeAnswer;
  current?: ProbeAnswer;
}

export interface ValidationResult {
  valid: boolean;
  errors: ModelError[];
  /** Cube's compile error, as `/v1/meta` would answer it; `null` when valid or the failure was YAML. */
  cubeMessage: string | null;
  /** Only when valid. */
  probes: ProbeResult[];
}

/** A snapshot compiled as Cube serves models, reachable only by the check. */
export interface CandidateHandle {
  compile(): Promise<void>;
  probe(probe: Probe): Promise<ProbeResult>;
}

export interface ValidateOptions {
  files: SnapshotFile[];
  lane: CompileLane;
  priority: Priority;
  probes: Probe[];
  /** Registers the candidate for `fn`, and drops it and its compiled model after. */
  withCandidate: <T>(fn: (candidate: CandidateHandle) => Promise<T>) => Promise<T>;
}

/**
 * Checks a snapshot: YAML syntax in every file first, then a compile through
 * Cube's own path with the options it serves models with, then each probe,
 * one at a time, since they are planned on the event loop.
 */
export async function validateSnapshot({ files, lane, priority, probes, withCandidate }: ValidateOptions): Promise<ValidationResult> {
  const yaml = yamlErrors(files);
  if (yaml.length) {
    return { valid: false, errors: yaml, cubeMessage: null, probes: [] };
  }

  const paths = new Set(files.map(({ path }) => path));
  return lane.run(priority, () => withCandidate(async (candidate) => {
    try {
      await candidate.compile();
    } catch (e: any) {
      const message = String(e?.message ?? e);
      if (message.startsWith('Compile errors:')) {
        const errors = placeByName(compileErrors(message, paths), files);
        return {
          valid: false,
          errors: errors.length ? errors : [{ path: null, kind: 'compile' as const, message }],
          cubeMessage: String(e),
          probes: [],
        };
      }
      return {
        valid: false,
        errors: [{ path: null, kind: 'compile' as const, message }],
        cubeMessage: String(e),
        probes: [],
      };
    }

    const results: ProbeResult[] = [];
    for (const probe of probes) {
      results.push(await candidate.probe(probe));
    }
    return { valid: true, errors: [], cubeMessage: null, probes: results };
  }));
}
