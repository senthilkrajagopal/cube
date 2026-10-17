import { Readable } from 'stream';

import { ParameterError, placeholdersOf, SqlRefusal, type SqlDialect } from '../../src/sql/classify';
import { bindParameters, type SqlParameter } from '../../src/sql/parameters';
import { openSession, RowCollector, type SqlCaps } from '../../src/sql/runner';
import { SqlRuns, type SqlTarget } from '../../src/sql/runs';

const caps: SqlCaps = { maxRows: 10, timeoutMs: 30000, maxBytes: 1024 * 1024 };
const noRefusal = (message: string): never => {
  throw new Error(`refused: ${message}`);
};
const INJECTION = '\'; DROP TABLE x; --';
const text = (value: string): SqlParameter => ({ type: 'text', value });
const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParameterError) {
      return [e.reason, e.message];
    }
    if (e instanceof SqlRefusal) {
      return [e.code, e.message];
    }
    throw e;
  }
  return null;
};

describe('{{name}} parameters: found in code only, as the database reads it', () => {
  test('in code, with spaces inside the braces or none; never in a string, a comment or a quoted name', () => {
    const sql = 'SELECT {{a}}, {{ b }}, \'{{c}}\', "{{d}}" /* {{e}} */ -- {{f}}\nFROM t WHERE x = {{a}}';
    expect(placeholdersOf(sql, 'postgres').map((p) => [p.name, sql.slice(p.start, p.end)])).toEqual([
      ['a', '{{a}}'], ['b', '{{ b }}'], ['a', '{{a}}'],
    ]);
    // MySQL's "…" is a string, BigQuery's `…` a name, MySQL's # a comment, PostgreSQL's $$…$$ a string.
    expect(placeholdersOf('SELECT "{{x}}", {{y}} # {{z}}', 'mysql').map((p) => p.name)).toEqual(['y']);
    expect(placeholdersOf('SELECT `{{x}}`, {{y}}', 'bigquery').map((p) => p.name)).toEqual(['y']);
    expect(placeholdersOf('SELECT $$ {{x}} $$, {{y}}', 'postgres').map((p) => p.name)).toEqual(['y']);
    expect(placeholdersOf('SELECT [{{x}}], {{y}}', 'mssql').map((p) => p.name)).toEqual(['y']);
    // Names are case-sensitive, ASCII, not starting with a digit.
    expect(placeholdersOf('SELECT {{Name_2}}, {{_x}}', 'oracle').map((p) => p.name)).toEqual(['Name_2', '_x']);
  });

  test('a {{…}} in code that isn\'t {{name}} is refused', () => {
    for (const bad of ['{{1a}}', '{{a b}}', '{{a}', '{{a-b}}', '{{"a"}}', '{{ }}', '{{a$b}}', '{{ /* c */ a }}', '{{é}}']) {
      expect([bad, reasonOf(() => placeholdersOf(`SELECT ${bad} FROM t`, 'postgres'))?.[0]]).toEqual([bad, 'malformed_placeholder']);
    }
  });

  test('a placeholder of the database\'s own, written by hand, is refused; what only looks like one is not', () => {
    const written: [SqlDialect, string][] = [
      ['postgres', 'SELECT $1'], ['redshift', 'SELECT * FROM t WHERE a = $2'],
      ['mysql', 'SELECT ?'], ['snowflake', 'SELECT ?'], ['snowflake', 'SELECT :1'],
      ['bigquery', 'SELECT @x'], ['bigquery', 'SELECT ?'], ['mssql', 'SELECT @x'], ['oracle', 'SELECT :x FROM dual'], ['oracle', 'SELECT :1 FROM dual'],
    ];
    for (const [dialect, sql] of written) {
      expect([dialect, sql, reasonOf(() => placeholdersOf(sql, dialect))?.[0]]).toEqual([dialect, sql, 'placeholder_written']);
    }
    const fine: [SqlDialect, string][] = [
      ['postgres', 'SELECT a::int, b ? \'k\' FROM t'], ['snowflake', 'SELECT v:field, a::int FROM t'],
      ['mssql', 'SELECT @@VERSION'], ['bigquery', 'SELECT @@project_id'], ['postgres', 'SELECT \'$1\', "?"'],
    ];
    for (const [dialect, sql] of fine) {
      expect([dialect, sql, reasonOf(() => placeholdersOf(sql, dialect))]).toEqual([dialect, sql, null]);
    }
    expect(reasonOf(() => placeholdersOf('SELECT ?', 'mysql'))?.[1])
      .toBe('The statement holds ?, a placeholder of the database\'s own: with parameters, write each as {{name}}');
  });

  test('a statement read two ways (comments nesting or not) must place its parameters the same both ways', () => {
    expect(reasonOf(() => placeholdersOf('SELECT 1 /* /* */ {{a}} */', 'snowflake'))?.[0]).toBe('not_read_only');
  });
});

describe('binding: xcube\'s placeholders in the {{name}}s\' places, typed, the values apart', () => {
  const parameters: Record<string, SqlParameter> = {
    t: text(INJECTION), n: { type: 'number', value: '-12.50' }, d: { type: 'date', value: '2026-02-28' }, b: { type: 'boolean', value: true },
  };
  const sql = 'SELECT {{t}}, {{n}}, {{d}}, {{b}}, x{{t}}';

  test('per dialect: generated placeholders only, each between spaces, never the user\'s name; the value never in the SQL', () => {
    const expected: Record<string, [string, string[]]> = {
      postgres: ['SELECT  $1::text ,  $2::numeric ,  $3::date ,  $4::boolean , x $1::text ', ['1', '2', '3', '4']],
      redshift: ['SELECT  $1::text ,  $2::numeric ,  $3::date ,  $4::boolean , x $1::text ', ['1', '2', '3', '4']],
      mysql: ['SELECT  ? ,  CAST(? AS DECIMAL(65, 2)) ,  CAST(? AS DATE) ,  ? , x ? ', ['1', '2', '3', '4', '5']],
      snowflake: ['SELECT  ? ,  ?::NUMBER(38, 2) ,  ?::DATE ,  ?::BOOLEAN , x ? ', ['1', '2', '3', '4', '5']],
      bigquery: ['SELECT  @p1 ,  @p2 ,  @p3 ,  @p4 , x @p1 ', ['p1', 'p2', 'p3', 'p4']],
      mssql: ['SELECT  @p1 ,  CAST(@p2 AS DECIMAL(38, 2)) ,  CAST(@p3 AS DATE) ,  @p4 , x @p1 ', ['p1', 'p2', 'p3', 'p4']],
      oracle: [
        'SELECT  :p1 ,  TO_NUMBER(:p2, \'99D99\', \'NLS_NUMERIC_CHARACTERS=\'\'.,\'\'\') ,  TO_DATE(:p3, \'YYYY-MM-DD\') ,  :p4 , x :p1 ',
        ['p1', 'p2', 'p3', 'p4'],
      ],
    };
    for (const [dialect, [rewritten, ids]] of Object.entries(expected)) {
      const bound = bindParameters(sql, dialect as SqlDialect, parameters);
      expect([dialect, bound.sql]).toEqual([dialect, rewritten]);
      expect(bound.binds.map((b) => b.id)).toEqual(ids);
      expect(bound.sql).not.toContain('DROP');
    }
    // A positional dialect binds a value at each of its places.
    expect(bindParameters(sql, 'mysql', parameters).binds.map((b) => b.value)).toEqual([INJECTION, '-12.50', '2026-02-28', true, INJECTION]);
    // A parameter named as a refused word is only ever a placeholder.
    expect(bindParameters('SELECT {{into}}', 'postgres', { into: text('x') }).sql).toBe('SELECT  $1::text ');
  });

  test('refusals: a value missing, one unused, one not of its type', () => {
    expect(reasonOf(() => bindParameters('SELECT {{a}}, {{b}}', 'postgres', { a: text('x') })))
      .toEqual(['missing_value', '{{b}} has no value']);
    expect(reasonOf(() => bindParameters('SELECT {{a}}', 'postgres', { a: text('x'), z: text('y') })))
      .toEqual(['unused_value', '"z" is given a value but used nowhere in the statement\'s code']);
    // In a string, {{a}} isn't a parameter: its value is unused.
    expect(reasonOf(() => bindParameters('SELECT \'{{a}}\'', 'postgres', { a: text('x') }))?.[0]).toBe('unused_value');
    const invalid: [SqlParameter, RegExp][] = [
      [{ type: 'number', value: '1e5' }, /decimal string/], [{ type: 'number', value: '12,5' }, /decimal string/],
      [{ type: 'number', value: '1'.repeat(39) }, /at most 38 digits/], [{ type: 'number', value: true }, /decimal string/],
      [{ type: 'date', value: '2026-02-30' }, /a day, written YYYY-MM-DD/], [{ type: 'date', value: '26-1-1' }, /YYYY-MM-DD/],
      [{ type: 'boolean', value: 'true' }, /true or false/], [{ type: 'text', value: false }, /a string/],
    ];
    for (const [parameter, message] of invalid) {
      const [reason, said] = reasonOf(() => bindParameters('SELECT {{a}}', 'postgres', { a: parameter })) as string[];
      expect([parameter, reason]).toEqual([parameter, 'invalid_value']);
      expect(said).toMatch(message);
    }
  });
});

describe('binding on drivers xcube can\'t reach from here: what each is sent', () => {
  test('Redshift: the cursor gets the rewritten SQL and the values apart', async () => {
    const sent: any[] = [];
    const client = {
      processID: 1,
      query: (q: any) => {
        if (typeof q === 'string') {
          return Promise.resolve();
        }
        sent.push({ text: q.text, values: q.values });
        return {
          on: () => undefined,
          read: (_n: number, cb: any) => cb(null, [], { fields: [] }),
          close: (cb?: any) => cb?.(),
        };
      },
    };
    const driver = { pool: { _factory: { create: async () => client, destroy: async () => undefined } }, prepareConnection: async () => undefined };
    const { sql, binds } = bindParameters('SELECT {{t}} AS v', 'redshift', { t: text(INJECTION) });
    const session = await openSession('redshift', driver, caps, noRefusal);
    await session.run(sql, new RowCollector(10, 1024), binds);
    await session.close();
    expect(sent).toEqual([{ text: 'SELECT  $1::text  AS v', values: [INJECTION] }]);
  });

  test('Snowflake: binds by position, the SQL with ? in their places', async () => {
    let options: any;
    const stmt = { getColumns: () => [], streamRows: () => Readable.from([]), cancel: (cb: () => void) => cb() };
    const driver = {
      getConnection: async () => ({
        execute: (o: any) => {
          options = o;
          setImmediate(() => o.complete(undefined, stmt));
          return stmt;
        },
      }),
      release: async () => undefined,
    };
    const { sql, binds } = bindParameters('SELECT {{t}}, {{n}}', 'snowflake', { t: text(INJECTION), n: { type: 'number', value: '3' } });
    const session = await openSession('snowflake', driver, caps, noRefusal);
    await session.run(sql, new RowCollector(10, 1024), binds);
    expect(options).toMatchObject({ sqlText: 'SELECT  ? ,  ?::NUMBER(38, 0) ', binds: [INJECTION, '3'] });
  });

  test('BigQuery: named parameters with their types, on the dry run and the job alike', async () => {
    const jobs: any[] = [];
    const driver = {
      options: { location: 'EU' },
      bigquery: {
        createQueryJob: async (o: any) => {
          jobs.push(o);
          return o.dryRun
            ? [{ metadata: { statistics: { query: { statementType: 'SELECT' } } } }]
            : [{ getQueryResults: async () => [[], null, { schema: { fields: [] } }], cancel: async () => undefined }];
        },
      },
    };
    const parameters: Record<string, SqlParameter> = {
      t: text(INJECTION), n: { type: 'number', value: '1.5' }, big: { type: 'number', value: `${'9'.repeat(30)}` }, d: { type: 'date', value: '2026-01-01' }, b: { type: 'boolean', value: false },
    };
    const { sql, binds } = bindParameters('SELECT {{t}}, {{n}}, {{big}}, {{d}}, {{b}}', 'bigquery', parameters);
    const session = await openSession('bigquery', driver, caps, noRefusal);
    await session.run(sql, new RowCollector(10, 1024), binds);
    const bound = {
      query: 'SELECT  @p1 ,  @p2 ,  @p3 ,  @p4 ,  @p5 ',
      params: { p1: INJECTION, p2: '1.5', p3: '9'.repeat(30), p4: '2026-01-01', p5: false },
      types: { p1: 'STRING', p2: 'NUMERIC', p3: 'BIGNUMERIC', p4: 'DATE', p5: 'BOOL' },
    };
    expect(jobs).toEqual([expect.objectContaining({ ...bound, dryRun: true }), expect.objectContaining(bound)]);
  });
});

describe('Oracle: a Boolean binds into SQL from 23ai', () => {
  test('an older Oracle is told it can\'t take one; 23ai binds it as BOOLEAN', async () => {
    const executed: any[] = [];
    const conn = (version: number) => ({
      oracleServerVersion: version,
      oracleServerVersionString: version >= 2300000000 ? '23.4.0.24.5' : '19.3.0.0.0',
      execute: async (sql: string, binds: any) => {
        executed.push([sql, binds]);
        return { metaData: [], resultSet: { getRows: async () => [], close: async () => undefined } };
      },
      break: async () => undefined,
      rollback: async () => undefined,
      close: async () => undefined,
    });
    const db = { OUT_FORMAT_ARRAY: 4001, BIND_IN: 3001, STRING: 'STRING', DB_TYPE_BOOLEAN: 'BOOLEAN' };
    const driver = (version: number) => ({ db, pool: { _factory: { create: async () => conn(version) } } });
    const { sql, binds } = bindParameters('SELECT {{b}}, {{t}} FROM dual', 'oracle', { b: { type: 'boolean', value: true }, t: text(INJECTION) });
    const old = await openSession('oracle', driver(1903000000), caps, noRefusal);
    expect(old.unbindable?.(binds)).toBe('Oracle binds a Boolean into SQL only from Oracle Database 23ai; this one is 19.3.0.0.0');
    const current = await openSession('oracle', driver(2304000000), caps, noRefusal);
    expect(current.unbindable?.(binds)).toBeNull();
    await current.run(sql, new RowCollector(10, 1024), binds);
    expect(executed.pop()).toEqual(['SELECT  :p1 ,  :p2  FROM dual', {
      p1: { dir: 3001, type: 'BOOLEAN', val: true }, p2: { dir: 3001, type: 'STRING', val: INJECTION },
    }]);
  });
});

describe('a run with parameters', () => {
  const target = (dialect: SqlTarget['dialect'], driver: any = {}): SqlTarget => ({ dialect, label: dialect, build: async () => ({ driver, secrets: [] }) });
  const runs = () => new SqlRuns('here', () => null, () => undefined);

  test('Dremio and Cube Store take no bound values: refused before anything connects', async () => {
    for (const dialect of ['dremio', 'cubestore'] as const) {
      const build = jest.fn();
      await expect(runs().run('m', { ...target(dialect), build }, {
        runId: 'r1', sql: 'SELECT {{a}}', parameters: { a: text('x') }, ...caps,
      })).rejects.toMatchObject({ code: 'parameters_unsupported', reason: dialect, redactedSql: 'SELECT {{a}}' });
      expect(build).not.toHaveBeenCalled();
    }
  });

  test('a refused binding answers invalid_parameters, with its reason, and connects nothing', async () => {
    const build = jest.fn();
    await expect(runs().run('m', { ...target('postgres'), build }, {
      runId: 'r2', sql: 'SELECT {{a}}', parameters: {}, ...caps,
    })).rejects.toMatchObject({ code: 'invalid_parameters', reason: 'missing_value', message: '{{a}} has no value' });
    // The check reads the SQL as it would run: a write is still refused, whatever the parameters.
    await expect(runs().run('m', { ...target('postgres'), build }, {
      runId: 'r3', sql: 'DELETE FROM t WHERE a = {{a}}', parameters: { a: text('x') }, ...caps,
    })).rejects.toMatchObject({ code: 'not_read_only', redactedSql: 'DELETE FROM t WHERE a =  $1::text' });
    expect(build).not.toHaveBeenCalled();
  });

  test('without parameters, {{…}} is the SQL\'s own text, as before', async () => {
    const sent: string[] = [];
    const client = {
      processID: 1,
      query: (q: any) => {
        if (typeof q === 'string') {
          return Promise.resolve();
        }
        sent.push(q.text);
        return { on: () => undefined, read: (_n: number, cb: any) => cb(null, [], { fields: [] }), close: (cb?: any) => cb?.() };
      },
    };
    const driver = { pool: { _factory: { create: async () => client, destroy: async () => undefined } }, prepareConnection: async () => undefined };
    await runs().run('m', target('postgres', driver), { runId: 'r4', sql: 'SELECT \'{{a}}\'', ...caps });
    expect(sent).toEqual(['SELECT \'{{a}}\'']);
  });
});
