import {
  classifySql, redactSql, SqlRefusal, withRowCap, type SqlDialect,
} from '../../src/sql/classify';

/** The refusal's code and statement kind, or `ok` and the kind. */
function verdict(sql: string, dialect: SqlDialect): string {
  try {
    return `ok:${classifySql(sql, dialect).statement}`;
  } catch (e) {
    if (e instanceof SqlRefusal) {
      return `${e.code}:${e.statement ?? '-'}`;
    }
    throw e;
  }
}

const reads = (dialect: SqlDialect, statements: string[]) => {
  for (const sql of statements) {
    expect([sql, verdict(sql, dialect)]).toEqual([sql, expect.stringMatching(/^ok:/)]);
  }
};

const refuses = (dialect: SqlDialect, cases: [string, string][]) => {
  for (const [sql, expected] of cases) {
    expect([sql, verdict(sql, dialect)]).toEqual([sql, expected]);
  }
};

describe('the SQL runner\'s check: one read', () => {
  test('PostgreSQL: reads, whatever their strings, comments and dollar quotes hold', () => {
    reads('postgres', [
      'SELECT 1',
      'select * from t where a = \'x; DELETE FROM t\'',
      'WITH a AS (SELECT 1) SELECT * FROM a',
      'WITH RECURSIVE a(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 3) SELECT * FROM a',
      '(SELECT 1) UNION (SELECT 2)',
      'SELECT 1 UNION ALL SELECT 2 EXCEPT SELECT 3',
      'SELECT $$ DELETE FROM t; $$',
      'SELECT $tag$ ; drop table t $tag$, a$b$c FROM t',
      'SELECT 1;',
      'SELECT 1; -- a last word',
      'SELECT "update", "into" FROM t',
      'SELECT E\'it\\\'s; DELETE FROM t\'',
      'SELECT \'C:\\\' AS path',
      '/* a comment */ SELECT 1',
      'SELECT /* nested /* comments */ DELETE */ 1',
      'SELECT 1 -- ; DELETE FROM t',
      'SELECT * FROM t ORDER BY a FETCH FIRST 5 ROWS ONLY',
      'SELECT a FROM t WHERE b IN (SELECT b FROM u) AND EXISTS (SELECT 1)',
      'SELECT last_update, created FROM t',
    ]);
    expect(verdict('EXPLAIN SELECT 1', 'postgres')).toBe('ok:explain');
    expect(verdict('EXPLAIN (FORMAT JSON, COSTS OFF) SELECT 1', 'postgres')).toBe('ok:explain');
    expect(verdict('EXPLAIN VERBOSE WITH a AS (SELECT 1) SELECT * FROM a', 'postgres')).toBe('ok:explain');
  });

  test('PostgreSQL: statements that aren\'t a SELECT, by their kind', () => {
    refuses('postgres', [
      ['INSERT INTO t VALUES (1)', 'not_read_only:insert'],
      ['UPDATE t SET a = 1', 'not_read_only:update'],
      ['DELETE FROM t', 'not_read_only:delete'],
      ['CREATE TABLE x (a int)', 'not_read_only:create'],
      ['DROP TABLE t', 'not_read_only:drop'],
      ['COPY t TO PROGRAM \'id\'', 'not_read_only:copy'],
      ['GRANT ALL ON t TO public', 'not_read_only:grant'],
      ['CALL p()', 'not_read_only:call'],
      ['VACUUM t', 'not_read_only:vacuum'],
      ['SET ROLE admin', 'not_read_only:set'],
      ['SET TRANSACTION READ WRITE', 'not_read_only:set'],
      ['REFRESH MATERIALIZED VIEW v', 'not_read_only:refresh'],
      ['COMMENT ON TABLE t IS \'x\'', 'not_read_only:comment'],
      ['DO $$ BEGIN END $$', 'not_read_only:do'],
      ['COMMIT', 'not_read_only:commit'],
      ['LOCK TABLE t', 'not_read_only:lock'],
      ['VALUES (1)', 'not_read_only:values'],
      ['TABLE t', 'not_read_only:table'],
      ['', 'not_read_only:-'],
      ['  -- only a comment', 'not_read_only:-'],
    ]);
  });

  test('PostgreSQL: a SELECT that writes, locks, or calls what acts outside the transaction', () => {
    refuses('postgres', [
      ['SELECT * INTO new_t FROM t', 'not_read_only:select'],
      ['SELECT * FROM t FOR UPDATE', 'not_read_only:select'],
      ['SELECT * FROM t FOR NO KEY UPDATE', 'not_read_only:select'],
      ['SELECT * FROM t FOR SHARE', 'not_read_only:select'],
      ['SELECT * FROM t FOR KEY SHARE', 'not_read_only:select'],
      ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'not_read_only:select'],
      ['WITH d AS (ＤＥＬＥＴＥ FROM t RETURNING *) SELECT * FROM d', 'not_read_only:select'],
      ['WITH d AS (\u200bDELETE FROM t RETURNING *) SELECT * FROM d', 'not_read_only:select'],
      ['SELECT pg_terminate_backend(123)', 'not_read_only:select'],
      ['SELECT pg_catalog.pg_terminate_backend(1)', 'not_read_only:select'],
      ['SELECT "pg_cancel_backend"(1)', 'not_read_only:select'],
      ['SELECT * FROM dblink(\'c\', \'delete from t\') AS t(a int)', 'not_read_only:select'],
      ['SELECT set_config(\'role\', \'admin\', false)', 'not_read_only:select'],
      ['SELECT query_to_xml(\'delete from t\', true, true, \'\')', 'not_read_only:select'],
      ['SELECT pg_read_file(\'/etc/passwd\')', 'not_read_only:select'],
      ['SELECT lo_export(1, \'/tmp/x\')', 'not_read_only:select'],
      ['EXPLAIN ANALYZE SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN ANALYSE SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN (ANALYZE) SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN (FORMAT JSON, ANALYZE true) SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN DELETE FROM t', 'not_read_only:explain'],
      ['EXPLAIN CREATE TABLE x AS SELECT 1', 'not_read_only:explain'],
    ]);
  });

  test('PostgreSQL: one statement, read as the database reads it', () => {
    refuses('postgres', [
      ['SELECT 1; SELECT 2', 'several_statements:-'],
      ['SELECT 1; DELETE FROM t', 'several_statements:-'],
      ['SELECT 1;;', 'several_statements:-'],
      // standard_conforming_strings: the backslash is a character, the string ends, and a second statement follows.
      ['SELECT \'\\\'; DELETE FROM t; --\'', 'several_statements:-'],
      ['SELECT * FROM t WHERE a IN (1) SELECT 2', 'several_statements:select'],
      ['(SELECT 1) SELECT 2', 'several_statements:select'],
      ['SELECT \'abc', 'not_read_only:-'],
      ['SELECT /* abc', 'not_read_only:-'],
      ['SELECT $$ abc', 'not_read_only:-'],
      ['SELECT (1', 'not_read_only:-'],
      ['SELECT 1)', 'not_read_only:-'],
      ['SELECT /* a /* b */ DELETE FROM t', 'not_read_only:-'],
    ]);
  });

  test('Redshift: a string or comment read both ways, as its settings may have it', () => {
    reads('redshift', ['SELECT \'a\' || \'b\'', 'SELECT 1 /* c */', 'EXPLAIN VERBOSE SELECT 1']);
    refuses('redshift', [
      // With backslash escapes, the string holds all of it; without, a second statement follows.
      ['SELECT \'\\\'; DELETE FROM t; --\'', 'several_statements:-'],
      ['SELECT \'it\\\'s\'', 'not_read_only:-'],
      ['SELECT /* a /* b */ 1', 'not_read_only:-'],
    ]);
  });

  test('MySQL: its comments, its quotes, and what it runs from a comment', () => {
    reads('mysql', [
      'SELECT 1 # a comment',
      'SELECT "a; DELETE FROM t", \'it\\\'s\' FROM `t`',
      'SELECT 1 --1',
      'SELECT 1 -- ; DELETE FROM t',
      'SELECT /*+ MAX_EXECUTION_TIME(10) */ 1',
      'EXPLAIN FORMAT=JSON SELECT 1',
      'EXPLAIN FORMAT = TREE SELECT 1',
    ]);
    refuses('mysql', [
      ['SELECT * FROM t INTO OUTFILE \'/tmp/x\'', 'not_read_only:select'],
      ['SELECT 1 INTO @x', 'not_read_only:select'],
      ['SELECT 1 /*! ; DELETE FROM t */', 'not_read_only:-'],
      ['SELECT 1 /*M! ; DELETE FROM t */', 'not_read_only:-'],
      ['SELECT * FROM t LOCK IN SHARE MODE', 'not_read_only:select'],
      ['SELECT * FROM t FOR SHARE', 'not_read_only:select'],
      ['SELECT LOAD_FILE(\'/etc/passwd\')', 'not_read_only:select'],
      ['SELECT 1 # x\n; DELETE FROM t', 'several_statements:-'],
      ['SELECT 1 --x; DELETE FROM t', 'several_statements:-'],
      ['EXPLAIN ANALYZE SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN t', 'not_read_only:explain'],
      ['REPLACE INTO t VALUES (1)', 'not_read_only:replace'],
      ['HANDLER t OPEN', 'not_read_only:handler'],
      ['DO SLEEP(1)', 'not_read_only:do'],
      ['SHOW TABLES', 'not_read_only:show'],
    ]);
  });

  test('Snowflake: its comments and dollar strings; SYSTEM$ functions refused', () => {
    reads('snowflake', [
      'SELECT 1 // a comment',
      'SELECT $$ ; DELETE FROM t $$, \'it\\\'s\'',
      'SELECT $1, $2 FROM @stage',
      'EXPLAIN USING TEXT SELECT 1',
      'SELECT * FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY a) = 1',
    ]);
    refuses('snowflake', [
      ['SELECT SYSTEM$CANCEL_ALL_QUERIES(1)', 'not_read_only:select'],
      ['SELECT system$abort_session(1)', 'not_read_only:select'],
      ['CALL p()', 'not_read_only:call'],
      ['EXECUTE IMMEDIATE \'DELETE FROM t\'', 'not_read_only:execute'],
      ['COPY INTO t FROM @s', 'not_read_only:copy'],
      ['SELECT 1 // ;\nDELETE FROM t', 'not_read_only:select'],
      ['BEGIN SELECT 1; END', 'several_statements:-'],
      ['PUT file:///tmp/x @s', 'not_read_only:put'],
      ['ALTER SESSION SET MULTI_STATEMENT_COUNT = 0', 'not_read_only:alter'],
    ]);
  });

  test('BigQuery: its strings and comments; no EXPLAIN; EXTERNAL_QUERY refused', () => {
    reads('bigquery', [
      'SELECT 1 # a comment',
      'SELECT """a \' ; DELETE FROM t""", \'\'\'b " c\'\'\'',
      'SELECT r\'\\\'\', b\'x\' FROM `proj.ds.t`',
      'SELECT * FROM UNNEST([1, 2]) AS x WITH OFFSET',
      'SELECT 1 UNION DISTINCT SELECT 2',
    ]);
    refuses('bigquery', [
      ['EXPLAIN SELECT 1', 'not_read_only:explain'],
      ['SELECT * FROM EXTERNAL_QUERY(\'c\', \'DELETE FROM t\')', 'not_read_only:select'],
      ['EXPORT DATA OPTIONS (uri = \'gs://b/*\') AS SELECT 1', 'not_read_only:export'],
      ['DECLARE x INT64', 'not_read_only:declare'],
      ['SELECT 1; SELECT 2', 'several_statements:-'],
    ]);
  });

  test('SQL Server: a batch without semicolons is still one statement; no EXPLAIN', () => {
    reads('mssql', [
      'SELECT TOP 5 * FROM [dbo].[t] WITH (NOLOCK)',
      'SELECT * FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
      'SELECT [update], [set] FROM t',
      'SELECT \'C:\\\' AS p',
      'WITH a AS (SELECT 1 AS x) SELECT x FROM a',
      'SELECT /* a /* b */ c */ 1',
      'SELECT N\'x\' UNION ALL SELECT N\'y\'',
      'SELECT a, COUNT(*) FROM t GROUP BY a WITH ROLLUP',
    ]);
    refuses('mssql', [
      ['SELECT 1 SELECT 2', 'several_statements:select'],
      ['SELECT * FROM t WHERE a IN (1) SELECT 2', 'several_statements:select'],
      ['SELECT 1 WITH a AS (SELECT 2 AS x) SELECT x FROM a', 'several_statements:select'],
      ['SELECT 1 EXEC xp_cmdshell \'dir\'', 'not_read_only:select'],
      ['SELECT 1 WAITFOR DELAY \'00:00:10\'', 'not_read_only:select'],
      ['SELECT 1 DROP TABLE t', 'not_read_only:select'],
      ['SELECT 1 SET NOCOUNT ON', 'not_read_only:select'],
      ['SELECT 1 DECLARE @x INT', 'not_read_only:select'],
      ['SELECT 1 KILL 52', 'not_read_only:select'],
      ['SELECT 1 BEGIN TRAN', 'not_read_only:select'],
      ['SELECT 1 COMMIT', 'not_read_only:select'],
      ['SELECT 1 USE master', 'not_read_only:select'],
      ['SELECT 1 TRUNCATE TABLE t', 'not_read_only:select'],
      ['SELECT 1 END CONVERSATION @h', 'not_read_only:select'],
      ['SELECT 1 ADD SIGNATURE TO p BY CERTIFICATE c', 'not_read_only:select'],
      ['SELECT * FROM OPENROWSET(\'SQLNCLI\', \'x\', \'EXEC p\')', 'not_read_only:select'],
      ['SELECT * FROM OPENQUERY(linked, \'DELETE FROM t\')', 'not_read_only:select'],
      ['SELECT * FROM t WITH (UPDLOCK)', 'not_read_only:select'],
      ['SELECT * FROM t FETCH NEXT 1 ROWS ONLY', 'not_read_only:select'],
      ['EXPLAIN SELECT 1', 'not_read_only:explain'],
      ['sp_who', 'not_read_only:sp_who'],
      ['EXEC sp_who', 'not_read_only:exec'],
      ['SELECT [a] FROM [t', 'not_read_only:-'],
    ]);
  });

  test('Oracle: no EXPLAIN PLAN (it writes PLAN_TABLE); network, file and dynamic-SQL packages refused', () => {
    reads('oracle', [
      'SELECT * FROM dual',
      'SELECT DBMS_RANDOM.VALUE FROM dual',
      'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR)',
      'SELECT 1 FROM dual;',
      'SELECT a FROM t CONNECT BY PRIOR a = b',
    ]);
    refuses('oracle', [
      ['EXPLAIN PLAN FOR SELECT 1 FROM dual', 'not_read_only:explain'],
      ['SELECT UTL_HTTP.REQUEST(\'http://x\') FROM dual', 'not_read_only:select'],
      ['SELECT DBMS_PIPE.RECEIVE_MESSAGE(\'a\', 10) FROM dual', 'not_read_only:select'],
      ['SELECT UTL_INADDR.GET_HOST_NAME FROM dual', 'not_read_only:select'],
      ['SELECT sys.dbms_xmlgen.getxml(\'select 1 from dual\') FROM dual', 'not_read_only:select'],
      ['SELECT HTTPURITYPE(\'http://x\').GETCLOB() FROM dual', 'not_read_only:select'],
      ['SELECT * FROM t FOR UPDATE', 'not_read_only:select'],
      ['BEGIN NULL; END;', 'several_statements:-'],
      ['DECLARE x NUMBER', 'not_read_only:declare'],
      ['LOCK TABLE t IN EXCLUSIVE MODE', 'not_read_only:lock'],
    ]);
  });

  test('Dremio: EXPLAIN PLAN reads; a backslash read both ways', () => {
    expect(verdict('EXPLAIN PLAN FOR SELECT 1', 'dremio')).toBe('ok:explain');
    expect(verdict('EXPLAIN PLAN WITH IMPLEMENTATION FOR SELECT 1', 'dremio')).toBe('ok:explain');
    expect(verdict('EXPLAIN PLAN INCLUDING ALL ATTRIBUTES WITHOUT IMPLEMENTATION FOR WITH a AS (SELECT 1) SELECT * FROM a', 'dremio')).toBe('ok:explain');
    reads('dremio', ['SELECT * FROM "space"."folder"."t"', 'SELECT \'C:\\\' AS p']);
    refuses('dremio', [
      ['CREATE TABLE t AS SELECT 1', 'not_read_only:create'],
      ['INSERT INTO t SELECT 1', 'not_read_only:insert'],
      ['ALTER TABLE t REFRESH METADATA', 'not_read_only:alter'],
      ['SELECT \'a\\\'; DROP TABLE t; --\'', 'several_statements:-'],
    ]);
  });

  test('Cube Store: SELECT and EXPLAIN; SHOW, DESCRIBE, its cache, queue and maintenance commands refused', () => {
    reads('cubestore', [
      'SELECT * FROM xcube_m.orders_main LIMIT 10 # a comment',
      'SELECT \'it\\\'s\'',
      'SELECT * FROM information_schema.tables',
      'SELECT * FROM system.tables',
      'SELECT * FROM system.partitions',
    ]);
    expect(verdict('EXPLAIN SELECT 1', 'cubestore')).toBe('ok:explain');
    refuses('cubestore', [
      ['SELECT * FROM system.cache', 'not_read_only:select'],
      ['select * from "system"."queue"', 'not_read_only:select'],
      ['SELECT * FROM `system`.`queue_results`', 'not_read_only:select'],
      ['CACHE GET \'k\'', 'not_read_only:cache'],
      ['QUEUE LIST \'p\'', 'not_read_only:queue'],
      ['SYS DROP QUERY CACHE', 'not_read_only:sys'],
      ['DUMP SELECT 1', 'not_read_only:dump'],
      ['EXPLAIN ANALYZE SELECT 1', 'not_read_only:explain'],
      ['EXPLAIN ANALYZE DETAILED SELECT 1', 'not_read_only:explain'],
      ['CREATE SCHEMA x', 'not_read_only:create'],
      ['DROP TABLE x.y', 'not_read_only:drop'],
      ['INSERT INTO x.y VALUES (1)', 'not_read_only:insert'],
      ['SHOW TABLES', 'not_read_only:show'],
      ['SHOW CHUNKS', 'not_read_only:show'],
      ['DESCRIBE x.y', 'not_read_only:describe'],
    ]);
  });

  test('a refusal says why, with its code', () => {
    try {
      classifySql('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres');
      throw new Error('not refused');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SqlRefusal);
      expect(e.message).toMatch(/DELETE/);
    }
    expect(() => classifySql('SELECT 1 SELECT 2', 'mssql')).toThrow(/one statement/);
    expect(() => classifySql('EXPLAIN ANALYZE SELECT 1', 'postgres')).toThrow(/ANALYZE runs the statement/);
    expect(() => classifySql('SELECT \'x', 'postgres')).toThrow(/string isn't closed/);
  });
});

describe('the SQL runner\'s redaction', () => {
  test('strings and numbers become ?, comments go; names and keywords stay', () => {
    expect(redactSql('SELECT * FROM t WHERE a = \'secret\' AND b = 42 -- note \'x\'', 'postgres'))
      .toBe('SELECT * FROM t WHERE a = ? AND b = ?');
    expect(redactSql('SELECT $$x$$, $q$y$q$, 1.5e3, "col 1" FROM t /* c */ LIMIT 10', 'postgres'))
      .toBe('SELECT ?, ?, ?, "col 1" FROM t   LIMIT ?');
    expect(redactSql('SELECT "pw" FROM t WHERE `a` = 7', 'mysql')).toBe('SELECT ? FROM t WHERE `a` = ?');
    expect(redactSql('SELECT x FROM t WHERE ssn = \'123-45', 'postgres')).toBe('SELECT x FROM t WHERE ssn = ?');
    expect(redactSql('SELECT (\'a\'', 'postgres')).toBe('SELECT (?');
  });

  test('the statement to run and its redaction come with it; a refusal carries the redaction too', () => {
    expect(classifySql('SELECT a FROM t WHERE b = \'x\'; -- bye', 'postgres')).toEqual({
      statement: 'select', sql: 'SELECT a FROM t WHERE b = \'x\'', redactedSql: 'SELECT a FROM t WHERE b = ?',
    });
    try {
      classifySql('DELETE FROM t WHERE ssn = \'123\'', 'postgres');
    } catch (e: any) {
      expect(e.redactedSql).toBe('DELETE FROM t WHERE ssn = ?');
    }
  });
});

describe('Cube Store\'s row cap', () => {
  test('its own top-level LIMIT, lowered to the cap; or one added on a line of its own', () => {
    expect(withRowCap('SELECT * FROM s.t ORDER BY a DESC', 'cubestore', 101)).toBe('SELECT * FROM s.t ORDER BY a DESC\nLIMIT 101');
    expect(withRowCap('SELECT * FROM s.t -- note', 'cubestore', 101)).toBe('SELECT * FROM s.t -- note\nLIMIT 101');
    expect(withRowCap('SELECT * FROM s.t LIMIT 5000', 'cubestore', 101)).toBe('SELECT * FROM s.t LIMIT 101');
    expect(withRowCap('SELECT * FROM s.t LIMIT 5 OFFSET 2', 'cubestore', 101)).toBe('SELECT * FROM s.t LIMIT 5 OFFSET 2');
    expect(withRowCap('SELECT * FROM s.t LIMIT 2, 500', 'cubestore', 101)).toBe('SELECT * FROM s.t LIMIT 2, 101');
    expect(withRowCap('WITH x AS (SELECT a FROM s.t LIMIT 900) SELECT * FROM x', 'cubestore', 101))
      .toBe('WITH x AS (SELECT a FROM s.t LIMIT 900) SELECT * FROM x\nLIMIT 101');
    expect(() => withRowCap('SELECT * FROM s.t LIMIT ALL', 'cubestore', 101)).toThrow(SqlRefusal);
  });
});
