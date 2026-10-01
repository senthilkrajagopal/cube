/**
 * What the SQL runner lets run: one statement, a read. A statement runs only
 * if it is a single `SELECT` (with `WITH` and set operations) or an `EXPLAIN`
 * without `ANALYZE`, holds nothing that writes or locks, and calls none of the
 * functions that act outside a read-only transaction.
 *
 * It is not a grammar. It reads the statement as each database's lexer would:
 * its strings, quoted names, comments and dollar quotes, so that what it
 * checks is the code the database runs, never text inside a string. The
 * database parses the rest. Where a database's lexing depends on its settings
 * (whether a backslash escapes a quote, whether comments nest), the statement
 * is read every way it could be, and must pass every reading. Anything that
 * can't be read (a string or comment not closed, parentheses not matched) is
 * refused.
 */

export type SqlDialect = 'postgres' | 'redshift' | 'mysql' | 'snowflake' | 'bigquery' | 'mssql' | 'oracle' | 'dremio' | 'cubestore';

export type StatementKind = 'select' | 'explain';

export type RefusalCode = 'not_read_only' | 'several_statements';

/** A statement the runner won't run, with its kind as far as it was read, and the SQL with its literals taken out. */
export class SqlRefusal extends Error {
  public constructor(
    public readonly code: RefusalCode,
    message: string,
    public readonly statement: string | null,
    public readonly redactedSql: string,
  ) {
    super(message);
  }
}

export interface ClassifiedSql {
  statement: StatementKind;
  /** The statement to send: a trailing `;`, and anything after it, taken off. */
  sql: string;
  /** The statement with its strings and numbers replaced by `?`, and its comments taken out. */
  redactedSql: string;
}

interface Token {
  kind: 'word' | 'quoted' | 'string' | 'number' | 'op';
  /** A word ASCII upper-cased; a quoted name as written between its quotes; an operator's character. */
  value: string;
  start: number;
  end: number;
  /** How many parentheses it is inside. */
  depth: number;
}

/** One way of reading a statement where the database's own depends on its settings. */
interface Reading {
  /** A backslash escapes the next character in a string or quoted name. */
  backslash: boolean;
  /** Block comments nest. */
  nested: boolean;
}

interface Rules {
  /** `#` starts a line comment. */
  hashComment: boolean;
  /** `//` starts a line comment. */
  slashComment: boolean;
  /** `--` starts a comment only before a space or a control character (MySQL). */
  dashNeedsSpace: boolean;
  /** `$tag$ … $tag$` strings, or only `$$ … $$`. */
  dollar: 'tagged' | 'plain' | false;
  doubleQuote: 'identifier' | 'string';
  backtick: boolean;
  brackets: boolean;
  /** `'''` and `"""` strings (BigQuery). */
  tripleQuotes: boolean;
  /** `E'…'` strings, whose backslashes escape whatever the setting (PostgreSQL). */
  eStrings: boolean;
  /** `/*! … *\/` holds code the database runs (MySQL): refused. */
  executableComments: boolean;
  /** The readings to pass, the database's usual one first: its literals are what the redaction takes out. */
  readings: Reading[];
  /** How EXPLAIN reads here: as a read, refused, or not a statement of the database. */
  explain: 'read' | 'writes' | 'none';
  /** Cube Store: its private tables refused, and SHOW and DESCRIBE explained. */
  cubeStore: boolean;
  /** Names refused anywhere, unquoted: statements that write or lock, and the words that start them. */
  deniedWords: Set<string>;
  /** A called function's name (its last part) that acts outside the transaction. */
  deniedFunction?: RegExp;
  /** A name refused anywhere, called or not (Oracle calls a function without arguments without parentheses). */
  deniedName?: RegExp;
}

const BOTH = [true, false];

const readings = (backslash: boolean[], nested: boolean[]): Reading[] => backslash.flatMap((b) => nested.map((n) => ({ backslash: b, nested: n })));

/** Writes and locks, anywhere in a read: data-modifying CTEs, `SELECT … INTO`, `FOR UPDATE`. */
const WRITES = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'INTO'];

/**
 * T-SQL runs a batch of statements without `;` between them, so a statement
 * after the read starts with one of these. They are reserved words there, so
 * a name using one is bracketed. Lock hints are refused too.
 */
const TSQL_STATEMENTS = [
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE', 'BULK', 'SET', 'DECLARE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'USE', 'KILL', 'SHUTDOWN', 'BACKUP', 'RESTORE', 'DBCC', 'CHECKPOINT',
  'RECONFIGURE', 'WAITFOR', 'UPDATETEXT', 'WRITETEXT', 'READTEXT', 'OPEN', 'CLOSE', 'DEALLOCATE', 'PRINT',
  'RAISERROR', 'THROW', 'IF', 'WHILE', 'GOTO', 'RETURN', 'BREAK', 'CONTINUE', 'REVERT', 'SETUSER', 'SEND',
  'RECEIVE', 'MOVE', 'GET', 'ENABLE', 'DISABLE', 'ADD', 'CONVERSATION', 'UPDLOCK', 'XLOCK', 'TABLOCKX',
];

/**
 * PostgreSQL's functions that act outside the read-only transaction or the
 * session: signal other backends, reach other connections, read or write the
 * server's files, run SQL from a string, or change settings.
 */
const PG_FUNCTIONS = new RegExp(`^(${[
  'dblink.*', 'pg_(terminate|cancel)_backend', 'pg_reload_conf', 'pg_rotate_logfile.*', 'pg_promote', 'pg_switch_(wal|xlog)',
  'pg_create_restore_point', 'pg_(start|stop)_backup', 'pg_backup_(start|stop)', 'lo_(import|export)', 'pg_read_.*', 'pg_ls_.*',
  'pg_stat_file', 'pg_file_.*', 'pg_logdir_ls', '(query|cursor)_to_xml.*', 'set_config', 'pg_(create|drop|copy)_.*slot',
  'pg_replication_.*', 'pg_logical_emit_message', 'pg_import_system_collations', 'pg_(wal|xlog)_replay_.*',
  'pg_log_backend_memory_contexts',
].join('|')})$`);

const base = {
  hashComment: false,
  slashComment: false,
  dashNeedsSpace: false,
  dollar: false,
  doubleQuote: 'identifier',
  backtick: false,
  brackets: false,
  tripleQuotes: false,
  eStrings: false,
  executableComments: false,
  explain: 'read',
  cubeStore: false,
} as const;

const RULES: Record<SqlDialect, Rules> = {
  postgres: {
    ...base,
    dollar: 'tagged',
    eStrings: true,
    // The runner sets standard_conforming_strings on: a backslash is a character.
    readings: readings([false], [true]),
    deniedWords: new Set(WRITES),
    deniedFunction: PG_FUNCTIONS,
  },
  redshift: {
    ...base,
    dollar: 'tagged',
    eStrings: true,
    readings: readings(BOTH, [true, false]),
    deniedWords: new Set(WRITES),
    deniedFunction: PG_FUNCTIONS,
  },
  mysql: {
    ...base,
    hashComment: true,
    dashNeedsSpace: true,
    doubleQuote: 'string',
    backtick: true,
    executableComments: true,
    // The runner takes NO_BACKSLASH_ESCAPES and ANSI_QUOTES out of the session's sql_mode.
    readings: readings([true], [false]),
    deniedWords: new Set([...WRITES, 'LOCK']),
    deniedFunction: /^(load_file|sys_exec|sys_eval)$/,
  },
  snowflake: {
    ...base,
    slashComment: true,
    dollar: 'plain',
    readings: readings([true], BOTH),
    deniedWords: new Set(WRITES),
    // Some SYSTEM$ functions act: cancel queries, abort sessions, set parameters.
    deniedFunction: /^system\$/,
  },
  bigquery: {
    ...base,
    hashComment: true,
    doubleQuote: 'string',
    backtick: true,
    tripleQuotes: true,
    explain: 'none',
    readings: readings([true], BOTH),
    deniedWords: new Set(WRITES),
    // It runs its SQL on another database.
    deniedFunction: /^external_query$/,
  },
  mssql: {
    ...base,
    brackets: true,
    explain: 'none',
    readings: readings([false], [true]),
    deniedWords: new Set([...WRITES, ...TSQL_STATEMENTS]),
    // They run a statement on another server, or read files.
    deniedFunction: /^(openquery|openrowset|opendatasource|xp_.*)$/,
  },
  oracle: {
    ...base,
    // EXPLAIN PLAN writes the plan into PLAN_TABLE.
    explain: 'writes',
    readings: readings([false], [false]),
    deniedWords: new Set(WRITES),
    // Packages that reach the network or files, run SQL from a string, or act; called with or without parentheses.
    deniedName: /^(utl_.*|dbms_(?!(xplan|lob|random)$).*|httpuritype)$/,
  },
  dremio: {
    ...base,
    // Its backslash is a character, its comments don't nest, and a backtick is an error (Dremio 26).
    readings: readings([false], [false]),
    deniedWords: new Set(WRITES),
  },
  cubestore: {
    ...base,
    hashComment: true,
    backtick: true,
    cubeStore: true,
    // Its backslash escapes a quote, its comments don't nest, and `#` starts one (Cube Store 1.7.45).
    readings: readings([true], [false]),
    deniedWords: new Set(WRITES),
  },
};

/** Its tables of cached results and queued queries, every model's: what Cube Store's cache and queue commands read. */
const CUBESTORE_PRIVATE_TABLES = new Set(['cache', 'queue', 'queue_results', 'replay_handles']);

/** What may come between EXPLAIN and the statement it explains, in the eight databases' syntaxes. */
const EXPLAIN_OPTIONS = new Set([
  'VERBOSE', 'FORMAT', 'TRADITIONAL', 'JSON', 'TREE', 'TEXT', 'USING', 'TABULAR', 'PLAN', 'INCLUDING', 'ALL', 'ATTRIBUTES',
  'WITHOUT', 'IMPLEMENTATION', 'AS', 'XML', 'FOR', 'TYPE', 'LOGICAL', 'PHYSICAL', 'COSTS',
]);

const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);

/** What may come between a set operator and the query after it. */
const SET_QUANTIFIERS = new Set(['ALL', 'DISTINCT', 'CORRESPONDING', 'BY', 'NAME', 'STRICT']);

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}\p{M}_$]/u;

const asciiUpper = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

class LexError extends Error {
  public constructor(message: string, public readonly at: number) {
    super(message);
  }
}

interface Lexed {
  tokens: Token[];
  /** Comments' spans, for the redaction. */
  comments: [number, number][];
}

/** The tokens of a statement as the database's lexer reads it, comments left out. */
function lex(sql: string, rules: Rules, reading: Reading): Lexed {
  const tokens: Token[] = [];
  const comments: [number, number][] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: Token['kind'], value: string, start: number, end: number) => {
    tokens.push({ kind, value, start, end, depth: 0 });
  };

  // A quoted run from `start` (its opening quote `quote`, `width` long): where it ends.
  const quoted = (start: number, quote: string, width: number, backslash: boolean, what: string): number => {
    let j = start + width;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === '\\') {
        j += 2;
      } else if (sql.startsWith(quote, j)) {
        // A doubled quote is the quote itself (a triple quote has none).
        if (width === 1 && sql[j + 1] === quote) {
          j += 2;
        } else {
          return j + width;
        }
      } else {
        j += 1;
      }
    }
    throw new LexError(`${what} isn't closed`, start);
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i += 1;
    } else if ((c === '-' && next === '-' && (!rules.dashNeedsSpace || i + 2 >= n || sql.charCodeAt(i + 2) <= 0x20))
      || (c === '#' && rules.hashComment)
      || (c === '/' && next === '/' && rules.slashComment)) {
      const end = sql.slice(i).search(/[\r\n]/);
      const stop = end === -1 ? n : i + end;
      comments.push([i, stop]);
      i = stop;
    } else if (c === '/' && next === '*') {
      if (rules.executableComments && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) {
        throw new LexError('MySQL runs what an executable comment (/*! … */) holds: it is refused', i);
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else if (reading.nested && sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) {
        throw new LexError('a comment isn\'t closed', i);
      }
      comments.push([i, j]);
      i = j;
    } else if (c === '\'' || (c === '"' && rules.doubleQuote === 'string')) {
      const triple = rules.tripleQuotes && sql.startsWith(c.repeat(3), i);
      const prefix = tokens[tokens.length - 1];
      // PostgreSQL's E'…' escapes with backslashes whatever the setting.
      const escaped = reading.backslash
        || (rules.eStrings && prefix?.kind === 'word' && prefix.end === i && prefix.value === 'E');
      const end = quoted(i, triple ? c.repeat(3) : c, triple ? 3 : 1, escaped, 'a string');
      push('string', sql.slice(i, end), i, end);
      i = end;
    } else if (c === '"' || (c === '`' && rules.backtick)) {
      const end = quoted(i, c, 1, reading.backslash, 'a quoted name');
      push('quoted', sql.slice(i + 1, end - 1).replace(c === '"' ? /""/g : /``/g, c), i, end);
      i = end;
    } else if (c === '[' && rules.brackets) {
      const end = quoted(i, ']', 1, false, 'a bracketed name');
      push('quoted', sql.slice(i + 1, end - 1).replace(/]]/g, ']'), i, end);
      i = end;
    } else if (c === '$' && rules.dollar && (rules.dollar === 'tagged' ? /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u : /^\$\$/).test(sql.slice(i, i + 130))) {
      const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i, i + 130))![0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        throw new LexError('a dollar-quoted string isn\'t closed', i);
      }
      push('string', sql.slice(i, close + tag.length), i, close + tag.length);
      i = close + tag.length;
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) {
        j += 1;
      }
      push('word', asciiUpper(sql.slice(i, j)), i, j);
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(sql.slice(i, i + 400))!;
      push('number', m[0], i, i + m[0].length);
      i += m[0].length;
    } else {
      push('op', c, i, i + 1);
      i += 1;
    }
  }

  return { tokens, comments };
}

/** Each token's depth in parentheses; they must match. */
function nest(tokens: Token[], length: number) {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'op' && token.value === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new LexError('a parenthesis closes that none opened', token.start);
      }
    }
    token.depth = depth;
    if (token.kind === 'op' && token.value === '(') {
      depth += 1;
    }
  }
  if (depth !== 0) {
    throw new LexError('a parenthesis isn\'t closed', length);
  }
}

/** The statement with its literals as `?` and its comments out. */
function redactWith(sql: string, lexed: Lexed): string {
  const spans: { start: number; end: number; with: string }[] = [
    ...lexed.tokens.filter((t) => t.kind === 'string' || t.kind === 'number').map((t) => ({ start: t.start, end: t.end, with: '?' })),
    ...lexed.comments.map(([start, end]) => ({ start, end, with: ' ' })),
  ].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += sql.slice(at, span.start) + span.with;
    at = span.end;
  }
  return (out + sql.slice(at)).replace(/[ \t]+$/gm, '').trim();
}

function redactPartial(sql: string, rules: Rules, at: number): string {
  try {
    return `${redactWith(sql.slice(0, at), lex(sql.slice(0, at), { ...rules, executableComments: false }, { backslash: false, nested: false }))} ?`.trim();
  } catch {
    return '?';
  }
}

/** The SQL with its literals redacted, however much of it can be read: for the audit record of any run. */
export function redactSql(sql: string, dialect: SqlDialect): string {
  const rules = RULES[dialect];
  try {
    return redactWith(sql, lex(sql, rules, rules.readings[0]));
  } catch (e) {
    if (e instanceof LexError) {
      // What was read up to the problem, its literals out; the rest as one `?`.
      return redactPartial(sql, rules, e.at);
    }
    throw e;
  }
}

const isWord = (t: Token | undefined, ...values: string[]) => t?.kind === 'word' && (values.length === 0 || values.includes(t.value));
const isOp = (t: Token | undefined, value: string) => t?.kind === 'op' && t.value === value;

/** A name's forms a database could match a keyword by. */
function wordForms(word: string): string[] {
  return [...new Set([word, word.toUpperCase(), word.normalize('NFKC').toUpperCase()])];
}

/** Checks one reading of a statement: what it is, and that it is a read. */
function check(sql: string, rules: Rules, reading: Reading, redacted: () => string): { statement: StatementKind; cut: number | null } {
  let lexed: Lexed;
  try {
    lexed = lex(sql, rules, reading);
    nest(lexed.tokens, sql.length);
  } catch (e) {
    if (e instanceof LexError) {
      throw new SqlRefusal('not_read_only', `xcube can't read the statement: ${e.message}`, null, redacted());
    }
    throw e;
  }
  let { tokens } = lexed;
  const refuse: (message: string, statement: string | null, code?: RefusalCode) => never = (message, statement, code = 'not_read_only') => {
    throw new SqlRefusal(code, message, statement, redacted());
  };

  // One statement: a `;` only at its end.
  const semicolon = tokens.findIndex((t) => isOp(t, ';') && t.depth === 0);
  let cut: number | null = null;
  if (semicolon !== -1) {
    if (semicolon < tokens.length - 1) {
      refuse('Only one statement runs at a time', null, 'several_statements');
    }
    cut = tokens[semicolon].start;
    tokens = tokens.slice(0, semicolon);
  }
  if (tokens.some((t) => isOp(t, ';'))) {
    refuse('Only one statement runs at a time', null, 'several_statements');
  }
  if (!tokens.length) {
    refuse('There is no statement to run', null);
  }

  // What it is: a query, perhaps in parentheses; an EXPLAIN of one; or SHOW (Cube Store).
  let start = 0;
  while (isOp(tokens[start], '(')) {
    start += 1;
  }
  const first = tokens[start];
  let statement: StatementKind;
  let query = start;
  if (isWord(first, 'SELECT', 'WITH')) {
    statement = 'select';
  } else if (isWord(first, 'EXPLAIN') && start === 0) {
    statement = 'explain';
    if (rules.explain === 'none') {
      refuse('This database has no EXPLAIN statement: only a SELECT runs here', 'explain');
    }
    if (rules.explain === 'writes') {
      refuse('Oracle\'s EXPLAIN PLAN writes the plan into PLAN_TABLE: only a SELECT runs here', 'explain');
    }
    let at = 1;
    if (isOp(tokens[at], '(')) {
      const close = tokens.findIndex((t, k) => k > at && isOp(t, ')') && t.depth === 0);
      if (tokens.slice(at, close).some((t) => isWord(t, 'ANALYZE', 'ANALYSE'))) {
        refuse('EXPLAIN ANALYZE runs the statement: only EXPLAIN without ANALYZE runs here', 'explain');
      }
      at = close + 1;
    }
    for (;;) {
      const t = tokens[at];
      if (isWord(t, 'ANALYZE', 'ANALYSE')) {
        refuse('EXPLAIN ANALYZE runs the statement: only EXPLAIN without ANALYZE runs here', 'explain');
      } else if (isWord(t, 'WITH') && isWord(tokens[at + 1], 'IMPLEMENTATION')) {
        at += 2;
      } else if ((t?.kind === 'word' && EXPLAIN_OPTIONS.has(t.value)) || isOp(t, '=')) {
        at += 1;
      } else {
        break;
      }
    }
    query = at;
    while (isOp(tokens[query], '(')) {
      query += 1;
    }
    if (!isWord(tokens[query], 'SELECT', 'WITH')) {
      refuse('Only an EXPLAIN of a SELECT runs here', 'explain');
    }
  } else if (rules.cubeStore && isWord(first, 'SHOW', 'DESCRIBE', 'DESC') && start === 0) {
    // SHOW TABLES and SCHEMAS, and DESCRIBE, aren't Cube Store's; its SHOW CHUNKS and the like answer every row at once.
    refuse('Read Cube Store\'s tables instead, with a LIMIT: information_schema.tables and .columns, system.tables, system.partitions, system.chunks, system.indexes', first.value.toLowerCase());
  } else {
    const kind = first.kind === 'word' ? first.value.toLowerCase() : null;
    refuse(`Only a SELECT${rules.explain === 'read' ? ' or an EXPLAIN' : ''} runs here${kind ? `: this is ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind.toUpperCase()} statement` : ''}`, kind);
  }

  // Nothing in it writes or locks.
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'word') {
      const denied = wordForms(t.value).find((form) => rules.deniedWords.has(form));
      // T-SQL's OFFSET … ROWS FETCH NEXT … is a read.
      const fetch = t.value === 'FETCH' && isWord(tokens[k - 1], 'ROW', 'ROWS');
      if (denied && !fetch) {
        refuse(`The statement holds ${denied}, which isn't a read: only reads run here (a name spelled so must be quoted)`, statement);
      }
      if (t.value === 'FETCH' && rules.deniedWords.has('OPEN') && !fetch) {
        refuse('The statement holds FETCH outside OFFSET … FETCH: only one read runs here', statement);
      }
      if (t.value === 'FOR' && (isWord(tokens[k + 1], 'SHARE') || (isWord(tokens[k + 1], 'KEY') && isWord(tokens[k + 2], 'SHARE')))) {
        refuse('SELECT … FOR SHARE takes locks: only reads run here', statement);
      }
    }
    if (t.kind === 'word' || t.kind === 'quoted') {
      const name = t.value.toLowerCase();
      if (rules.deniedName?.test(name)) {
        refuse(`${name.toUpperCase()} is refused: it can act outside a read`, statement);
      }
      if (rules.deniedFunction?.test(name) && isOp(tokens[k + 1], '(')) {
        refuse(`The function ${name} is refused: it acts outside a read-only transaction`, statement);
      }
      if (rules.cubeStore && name === 'system' && isOp(tokens[k + 1], '.')
        && (tokens[k + 2]?.kind === 'word' || tokens[k + 2]?.kind === 'quoted')
        && CUBESTORE_PRIVATE_TABLES.has(tokens[k + 2].value.toLowerCase())) {
        refuse(`system.${tokens[k + 2].value.toLowerCase()} holds Cube's cached results and queued queries: it isn't read here`, statement);
      }
    }
  }

  // One statement: every query at the top level after its first follows a set operator.
  // A query in parentheses counts as the first; WITH's comes after its CTEs.
  let seen = isWord(tokens[query], 'WITH') && !isOp(tokens[query - 1], '(') ? 0 : 1;
  for (let k = query + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth === 0 && isWord(t, 'SELECT')) {
      let before = k - 1;
      while (before > query && tokens[before].kind === 'word' && SET_QUANTIFIERS.has(tokens[before].value)) {
        before -= 1;
      }
      if (!(tokens[before].kind === 'word' && SET_OPERATORS.has(tokens[before].value)) && seen > 0) {
        refuse('Only one statement runs at a time', statement, 'several_statements');
      }
      seen += 1;
    }
  }
  return { statement, cut };
}

/**
 * Checks that a statement is one read, in a database's dialect: what to run,
 * and the statement with its literals redacted. Throws `SqlRefusal`.
 */
export function classifySql(sql: string, dialect: SqlDialect): ClassifiedSql {
  const rules = RULES[dialect];
  let redactedSql: string | undefined;
  const redacted = () => {
    redactedSql ??= redactSql(sql, dialect);
    return redactedSql;
  };
  const results = rules.readings.map((reading) => check(sql, rules, reading, redacted));
  const [primary] = results;
  if (results.some((r) => r.statement !== primary.statement)) {
    throw new SqlRefusal('not_read_only', 'xcube can\'t read the statement one way: it reads differently as this database may be set', null, redacted());
  }
  const run = (primary.cut === null ? sql : sql.slice(0, primary.cut)).trim();
  return { statement: primary.statement, sql: run, redactedSql: redactSql(run, dialect) };
}

/**
 * A SELECT capped at `cap` rows by its own top-level LIMIT, for a database
 * that answers every row at once (Cube Store): a LIMIT added after it, or its
 * own lowered. Wrapping it in a subquery would lose its order.
 */
export function withRowCap(sql: string, dialect: SqlDialect, cap: number): string {
  const rules = RULES[dialect];
  const { tokens } = lex(sql, rules, rules.readings[0]);
  nest(tokens, sql.length);
  const limit = tokens.findIndex((t) => t.depth === 0 && isWord(t, 'LIMIT'));
  if (limit === -1) {
    // On a line of its own: the statement may end in a line comment.
    return `${sql}\nLIMIT ${cap}`;
  }
  const counts = [tokens[limit + 1]];
  if (isOp(tokens[limit + 2], ',')) {
    counts.push(tokens[limit + 3]);
  }
  if (counts.some((t) => t?.kind !== 'number' || !/^[0-9]+$/.test(t.value))) {
    throw new SqlRefusal('not_read_only', 'A LIMIT here is a whole number', 'select', redactSql(sql, dialect));
  }
  let out = sql;
  for (const t of [...counts].reverse()) {
    out = `${out.slice(0, t.start)}${Math.min(Number(t.value), cap)}${out.slice(t.end)}`;
  }
  return out;
}
