import {
  checkedSnapshot,
  contentHash,
  DEFAULT_LIMITS,
  fileHash,
  MODEL_ID,
  SnapshotError,
} from '../../src/model/snapshot';

describe('contentHash', () => {
  // The golden vector wechart tests too: its version is the first 16 characters.
  test('is the SHA-256 of the files sorted by path, as [{fileName, content}]', () => {
    const files = [
      { path: 'b/c.yml', content: 'views: []\n' },
      { path: 'a.yml', content: 'cubes: []\n' },
    ];
    expect(contentHash(files)).toBe('43efbceb5daf2a138cb1e7d88413bf03473b63bb62c1c3466b94ac3cc3a15045');
    expect(contentHash([...files].reverse())).toBe(contentHash(files));
  });

  test('of no files is the hash of []', () => {
    expect(contentHash([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });

  test('sorts by byte order, so upper case comes first', () => {
    const a = [{ path: 'b.yml', content: '' }, { path: 'B.yml', content: 'x' }];
    expect(contentHash(a)).toBe(contentHash([a[1], a[0]]));
  });

  test('a file hash is the SHA-256 of its content', () => {
    expect(fileHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('checkedSnapshot', () => {
  const all = { ...DEFAULT_LIMITS, fileTypes: 'all' as const };
  const ok = (path: string) => checkedSnapshot([{ path, content: '' }], all);
  const refused = (path: string) => {
    expect(() => ok(path)).toThrow(SnapshotError);
  };

  test('takes model file paths Cube reads', () => {
    for (const path of ['a.yml', 'cubes/orders.yaml', 'x/y/z.js', 'm.jinja', 'p.py', '_a/b-c.d.yml']) {
      expect(ok(path)).toEqual([{ path, content: '' }]);
    }
  });

  test('refuses other paths', () => {
    for (const path of ['../a.yml', 'a/../b.yml', '/a.yml', 'a.txt', '.hidden.yml', 'a b.yml', 'ü.yml', 'a//b.yml', '', 'a/']) {
      refused(path);
    }
    refused(`${'a'.repeat(510)}.yml`);
  });

  test('takes plain YAML only, unless told to take every kind', () => {
    expect(checkedSnapshot([{ path: 'a.yml', content: 'cubes: []' }])).toHaveLength(1);
    for (const file of [
      { path: 'a.js', content: 'cube(`a`, {})' },
      { path: 'globals.py', content: 'x = 1' },
      { path: 'a.jinja', content: '' },
      { path: 'a.yml', content: 'cubes:\n{% for x in y %}\n{% endfor %}' },
      { path: 'a.yaml', content: 'cubes: [{ name: "{{ x }}" }]' },
    ]) {
      expect(() => checkedSnapshot([file])).toThrow(/only plain YAML/);
      expect(checkedSnapshot([file], all)).toHaveLength(1);
    }
  });

  test('refuses a path twice', () => {
    expect(() => checkedSnapshot([{ path: 'a.yml', content: '' }, { path: 'a.yml', content: 'x' }]))
      .toThrow(/Duplicate/);
  });

  test('sorts by path', () => {
    const sorted = checkedSnapshot([{ path: 'b.yml', content: '' }, { path: 'a.yml', content: '' }]);
    expect(sorted.map(({ path }) => path)).toEqual(['a.yml', 'b.yml']);
  });

  test('keeps to the limits', () => {
    const limits = { ...DEFAULT_LIMITS, maxBytes: 10, maxFileBytes: 6, maxFiles: 2 }; // YAML only, the default
    expect(() => checkedSnapshot([{ path: 'a.yml', content: '1234567' }], limits)).toThrow(/larger than/);
    expect(() => checkedSnapshot([
      { path: 'a.yml', content: '123456' },
      { path: 'b.yml', content: '123456' },
    ], limits)).toThrow(/at most 10 bytes/);
    expect(() => checkedSnapshot([
      { path: 'a.yml', content: '' }, { path: 'b.yml', content: '' }, { path: 'c.yml', content: '' },
    ], limits)).toThrow(/at most 2 files/);
    try {
      checkedSnapshot([{ path: 'a.yml', content: '1234567' }], limits);
    } catch (e: any) {
      expect(e.status).toBe(413);
    }
  });
});

test('model ids', () => {
  for (const id of ['dev', 'demo', 'wechart-prod', 'a', '0_x']) {
    expect(MODEL_ID.test(id)).toBe(true);
  }
  for (const id of ['', 'Dev', '-a', '_a', 'a.b', 'a'.repeat(64)]) {
    expect(MODEL_ID.test(id)).toBe(false);
  }
});
