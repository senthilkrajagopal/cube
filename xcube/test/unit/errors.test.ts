import { prepareCompiler } from '@cubejs-backend/schema-compiler';

import { compileErrors, placeByName, yamlErrors } from '../../src/model/errors';

/** Cube's own compile error for these files, as it throws it. */
async function cubeError(files: { path: string; content: string }[]): Promise<Error> {
  const { compiler } = prepareCompiler({
    localPath: () => '/nowhere',
    dataSchemaFiles: async () => files.map(({ path, content }) => ({ fileName: path, content })),
  }, { standalone: true, allowNodeRequire: false });
  try {
    await compiler.compile();
  } catch (e: any) {
    return e;
  }
  throw new Error('It compiled');
}

describe('yamlErrors', () => {
  test('finds every file\'s YAML error, with its line and column', () => {
    const errors = yamlErrors([
      { path: 'a.yml', content: 'cubes:\n  - name: a\n   bad: indent\n' },
      { path: 'b.yaml', content: 'cubes: [\n' },
      { path: 'ok.yml', content: 'cubes: []\n' },
    ]);
    expect(errors.map(({ path, kind, line }) => [path, kind, line])).toEqual([
      ['a.yml', 'yaml', 3],
      ['b.yaml', 'yaml', 2],
    ]);
    expect(errors[0].column).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/indentation|mapping/);
  });

  test('leaves templated YAML and other kinds to Cube', () => {
    expect(yamlErrors([
      { path: 'j.yml', content: 'cubes:\n{% for x in y %}\n  - bad: [\n{% endfor %}\n' },
      { path: 'c.js', content: 'cube(' },
    ])).toEqual([]);
  });
});

describe('compileErrors', () => {
  test('reads each of Cube\'s errors, and places those about a cube in the file defining it', async () => {
    const files = [
      { path: 'cubes/a.yml', content: 'cubes:\n  - name: a\n    sql_table: t\n    measures:\n      - name: c\n        type: nope\n' },
      { path: 'cubes/b.js', content: 'cube(`b`, {\n  sql: `select 1`,\n  measures: { c: { type: `count` } \n});\n' },
      { path: 'views/v.js', content: 'view(`v`, {\n  cubes: [{ join_path: nope, includes: `*` }],\n});\n' },
    ];
    const e = await cubeError(files);
    expect(e.message).toMatch(/^Compile errors:/);

    const errors = placeByName(compileErrors(e.message, new Set(files.map(({ path }) => path))), files);
    const aboutA = errors.find(({ message }) => message.startsWith('a cube:'));
    expect(aboutA).toMatchObject({ path: 'cubes/a.yml', kind: 'compile' });
    // A syntax error Cube names no file for stays unplaced, for the caller to place.
    expect(errors.find(({ message }) => /Unexpected token/.test(message))).toMatchObject({ path: null });
  });

  test('places by name in YAML and JS, and leaves unknown names', () => {
    const files = [
      { path: 'a.yml', content: 'cubes:\n  - name: orders\nviews:\n  - name: sales\n' },
      { path: 'b.js', content: "cube('customers', {});\nview(\"people\", {});\n" },
    ];
    const errors = placeByName([
      { path: null, kind: 'compile', message: 'orders cube: bad' },
      { path: null, kind: 'compile', message: 'sales view: bad' },
      { path: null, kind: 'compile', message: 'customers cube -> measures: bad' },
      { path: null, kind: 'compile', message: 'people view: bad' },
      { path: null, kind: 'compile', message: 'ghost cube: bad' },
      { path: null, kind: 'compile', message: 'nope is not defined' },
      { path: 'x.yml', kind: 'compile', message: 'orders cube: kept where Cube put it' },
    ], files);
    expect(errors.map(({ path }) => path)).toEqual(['a.yml', 'a.yml', 'b.js', 'b.js', null, null, 'x.yml']);
  });

  test('keeps errors that name no file, with a null path', async () => {
    const files = [
      { path: 'a.yml', content: 'cubes:\n  - name: dup\n    sql_table: t\n' },
      { path: 'b.yml', content: 'cubes:\n  - name: dup\n    sql_table: t\n' },
    ];
    const e = await cubeError(files);
    const errors = compileErrors(e.message, new Set(files.map(({ path }) => path)));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(({ message }) => /dup/.test(message))).toBe(true);
  });

  test('keeps the reasons Cube gives below a message with its message, for each cube', async () => {
    // Cube's own schema, unpatched here, refuses a pre-aggregation meta with a reason per alternative.
    const cube = (name: string) => `cubes:\n  - name: ${name}\n    sql_table: t\n`
      + '    dimensions:\n      - { name: k, sql: k, type: string, primary_key: true }\n'
      + '    measures:\n      - { name: count, type: count }\n'
      + '    pre_aggregations:\n      - name: r\n        measures: [count]\n        meta: { by: x }\n';
    const files = [{ path: 'cubes/a.yml', content: cube('a') }, { path: 'cubes/b.yml', content: cube('b') }];
    const e = await cubeError(files);
    expect(e.message).toContain('Possible reasons (one of):\n\t* ');

    const errors = placeByName(compileErrors(e.message, new Set(files.map(({ path }) => path))), files);
    expect(errors.map(({ path }) => path)).toEqual(['cubes/a.yml', 'cubes/b.yml']);
    for (const [error, name] of [[errors[0], 'a'], [errors[1], 'b']] as const) {
      expect(error.message).toMatch(new RegExp(`^${name} cube: .*\nPossible reasons \\(one of\\):\n\t\\* `));
      expect(error.message).toContain('(preAggregations.r.meta = [object Object]) is not allowed');
    }
  });

  test('reads the grouped format', () => {
    const message = [
      'Compile errors:',
      'cubes/a.yml Errors:',
      'a cube: measure c: type must be one of …',
      '',
      'cubes/b.js Errors:',
      'Syntax Error: Unexpected token (4:0)',
      '  3 |   measures: { c: { type: `count` } ',
      '> 4 | });',
      '    | ^',
      '',
      'Errors:',
      'nope is not defined',
      'c cube: "x" does not match any of the allowed types',
      'Possible reasons (one of):',
      '\t* (x.y = 1) is not allowed',
      '\t* "x.z" is required',
      '',
      'Possible reasons (one of):',
      '',
      'elsewhere.yml Errors:',
      'from a file the snapshot does not have',
      '',
    ].join('\n');
    expect(compileErrors(message, new Set(['cubes/a.yml', 'cubes/b.js']))).toEqual([
      { path: 'cubes/a.yml', kind: 'compile', message: 'a cube: measure c: type must be one of …' },
      { path: 'cubes/b.js', kind: 'compile', message: 'Syntax Error: Unexpected token (4:0)', line: 4, column: 1 },
      { path: null, kind: 'compile', message: 'nope is not defined' },
      { path: null, kind: 'compile', message: 'c cube: "x" does not match any of the allowed types\nPossible reasons (one of):\n\t* (x.y = 1) is not allowed\n\t* "x.z" is required' },
      // Reasons with no message above them are kept, as a message of their own.
      { path: null, kind: 'compile', message: 'Possible reasons (one of):' },
      { path: null, kind: 'compile', message: 'from a file the snapshot does not have' },
    ]);
  });
});
