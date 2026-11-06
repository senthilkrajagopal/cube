import { JoinGraph, type JoinEdge } from '@cubejs-backend/schema-compiler/dist/src/compiler/JoinGraph';
import type { CubeDefinition } from '@cubejs-backend/schema-compiler/dist/src/compiler/CubeSymbols';
import type { CubeEvaluator, MeasureDefinition } from '@cubejs-backend/schema-compiler/dist/src/compiler/CubeEvaluator';
import type { CubeValidator } from '@cubejs-backend/schema-compiler/dist/src/compiler/CubeValidator';
import type { ErrorReporter } from '@cubejs-backend/schema-compiler/dist/src/compiler/ErrorReporter';

/**
 * The cube `meta` key that lets a cube with no primary key, but with measures,
 * join other cubes: `meta: { xcube_keyless_joins: true }`.
 *
 * Cube refuses every join of such a cube, as a join that repeats its rows would
 * leave nothing to count them once by. A many_to_one or one_to_one join from
 * the cube can't repeat them, so an opted-in cube keeps those; its other joins,
 * and joins to it, are judged as Cube judges them. Each compile then refuses an
 * opted-in cube that any chain of joins could still repeat (a one_to_many join
 * beyond the cube it joins, say): Cube's legacy planner refuses such a query,
 * and Tesseract answers it with wrong numbers.
 */
export const KEYLESS_JOINS = 'xcube_keyless_joins';

/** The relationships, as Cube normalizes them, of the joins that can't repeat the joining cube's rows. */
const KEEPS_ROWS = new Set(['belongsTo', 'hasOne']);

/** Stands in for an opted-in cube's key while Cube judges its joins. */
const PRETENDED_KEY = '__xcube_keyless';

export function keylessJoinsOptedIn(cube: CubeDefinition): boolean {
  return (cube as { meta?: Record<string, unknown> }).meta?.[KEYLESS_JOINS] === true;
}

/**
 * Cube's JoinGraph with the opt-in. `prepareCompiler` builds its join graph
 * from the module's export, which `installKeylessJoins` points here.
 */
export class KeylessJoinGraph extends JoinGraph {
  protected readonly evaluator: CubeEvaluator;

  /** Every edge of the compile in progress. */
  protected compiledEdges: JoinEdge[] = [];

  /** The opted-in cubes of the compile in progress that kept a join only by opting in. */
  protected keylessCubes: string[] = [];

  public constructor(cubeValidator: CubeValidator, cubeEvaluator: CubeEvaluator) {
    super(cubeValidator, cubeEvaluator);
    this.evaluator = cubeEvaluator;
  }

  public override compile(cubes: unknown, errorReporter: ErrorReporter): void {
    this.compiledEdges = [];
    this.keylessCubes = [];
    super.compile(cubes, errorReporter);
    for (const cube of this.keylessCubes) {
      const edge = this.repeatingEdge(cube);
      if (edge) {
        errorReporter.inContext(`${cube} cube`).error(
          `primary key for '${cube}' is required: it joins with meta ${KEYLESS_JOINS}, ` +
          `but the ${edge.join.relationship} join from '${edge.from}' to '${edge.to}' can repeat its rows`
        );
      }
    }
  }

  protected override buildJoinEdges(cube: CubeDefinition, errorReporter: ErrorReporter): Array<[string, JoinEdge]> {
    const edges = this.needsKey(cube) ? this.keylessJoinEdges(cube, errorReporter) : super.buildJoinEdges(cube, errorReporter);
    this.compiledEdges.push(...edges.map(([, edge]) => edge));
    return edges;
  }

  /**
   * Whether Cube would refuse every join of this opted-in cube for want of a
   * key: it has none, and has a measure Cube counts as one a join repeats
   * (JoinGraph.buildJoinEdges's `getMultipliedMeasures`).
   */
  protected needsKey(cube: CubeDefinition): boolean {
    if (!cube.joins?.length || !keylessJoinsOptedIn(cube) || this.evaluator.primaryKeys[cube.name]?.length) {
      return false;
    }
    return Object.values(this.evaluator.measuresForCube(cube.name)).some((m: MeasureDefinition) => (m.sql &&
        this.evaluator.funcArguments(m.sql).length === 0 &&
        m.sql() === 'count(*)') ||
      ['sum', 'avg', 'count', 'number'].includes(m.type));
  }

  /**
   * The cube's joins that can't repeat its rows, as Cube judges them with a key
   * pretended for the cube. Its other joins are judged as they are, without
   * one, where Cube refuses them as it always has.
   */
  protected keylessJoinEdges(cube: CubeDefinition, errorReporter: ErrorReporter): Array<[string, JoinEdge]> {
    const joins = cube.joins ?? [];
    const keeps = joins.filter(join => KEEPS_ROWS.has(join.relationship));
    const others = joins.filter(join => !KEEPS_ROWS.has(join.relationship));
    if (others.length) {
      super.buildJoinEdges({ ...cube, joins: others }, errorReporter);
    }
    const keys = this.evaluator.primaryKeys;
    const own = keys[cube.name];
    keys[cube.name] = [PRETENDED_KEY];
    let edges: Array<[string, JoinEdge]>;
    try {
      edges = super.buildJoinEdges({ ...cube, joins: keeps }, errorReporter);
    } finally {
      keys[cube.name] = own;
    }
    if (edges.length) {
      this.keylessCubes.push(cube.name);
    }
    return edges;
  }

  /**
   * An edge that could repeat the cube's rows in a join tree, if any could.
   *
   * Cube's join trees follow joins from the cube that declares them, and no join
   * to this cube survives, so a tree that holds it is rooted at it and holds only
   * edges from cubes it reaches. Cube counts the root's rows repeated when,
   * walking out from it along the tree, an edge repeats the cube at its near end
   * (`findMultiplicationFactorFor`). Any of those edges may meet in one tree, so
   * the walk takes every one of them but the edge it came in on.
   */
  protected repeatingEdge(cube: string): JoinEdge | undefined {
    const reached = new Set([cube]);
    for (const node of reached) {
      for (const edge of this.compiledEdges) {
        if (edge.from === node) {
          reached.add(edge.to);
        }
      }
    }
    const edges = this.compiledEdges.filter(edge => reached.has(edge.from));
    const visited = new Set([cube]);
    const pending: Array<[string, JoinEdge | undefined]> = [[cube, undefined]];
    while (pending.length) {
      const [node, via] = pending.pop()!;
      for (const edge of edges) {
        if (edge === via || (edge.from !== node && edge.to !== node)) {
          continue;
        }
        if (this.checkIfCubeMultiplied(node, edge)) {
          return edge;
        }
        const next = edge.from === node ? edge.to : edge.from;
        if (!visited.has(next)) {
          visited.add(next);
          pending.push([next, edge]);
        }
      }
    }
    return undefined;
  }
}

/** Points Cube's compiler at `KeylessJoinGraph`, for every model this process compiles. */
export function installKeylessJoins(): void {
  // eslint-disable-next-line global-require
  const exported: { JoinGraph: typeof JoinGraph } = require('@cubejs-backend/schema-compiler/dist/src/compiler/JoinGraph');
  exported.JoinGraph = KeylessJoinGraph;
}
