import { CubeValidator } from '@cubejs-backend/schema-compiler/dist/src/compiler/CubeValidator';
import type { ErrorReporter } from '@cubejs-backend/schema-compiler/dist/src/compiler/ErrorReporter';

/**
 * Cube's CubeValidator, letting every pre-aggregation carry a `meta` of any
 * shape, as cubes and their members can: a writer's own marks, which Cube
 * neither reads nor builds from.
 *
 * Cube's schema has no `meta` on a pre-aggregation, so each is checked as Cube
 * checks it with its `meta` set aside. The `meta` stays on the definition, and
 * Cube's pre-aggregation APIs return it; it has no part in a rollup's SQL, so
 * none in its table name, structure version or matching.
 */
export class PreAggregationMetaValidator extends CubeValidator {
  public override validate(cube: any, errorReporter: ErrorReporter): ReturnType<CubeValidator['validate']> {
    const aside: Array<[Record<string, unknown>, unknown]> = [];
    if (!cube.isView) {
      for (const preAggregation of Object.values<Record<string, unknown>>(cube.preAggregations ?? {})) {
        if (preAggregation && Object.prototype.hasOwnProperty.call(preAggregation, 'meta')) {
          aside.push([preAggregation, preAggregation.meta]);
          delete preAggregation.meta;
        }
      }
    }
    try {
      return super.validate(cube, errorReporter);
    } finally {
      for (const [preAggregation, meta] of aside) {
        preAggregation.meta = meta;
      }
    }
  }
}

/** Points Cube's compiler at `PreAggregationMetaValidator`, for every model this process compiles. */
export function installPreAggregationMeta(): void {
  // eslint-disable-next-line global-require
  const exported: { CubeValidator: typeof CubeValidator } = require('@cubejs-backend/schema-compiler/dist/src/compiler/CubeValidator');
  exported.CubeValidator = PreAggregationMetaValidator;
}
