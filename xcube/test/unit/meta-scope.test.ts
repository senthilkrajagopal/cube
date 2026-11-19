import { MAX_META_CUBES, metaScopeOf, MetaScopeError, scopedMeta } from '../../src/meta-scope';

describe('metaScopeOf', () => {
  test('reads a GET\'s query as Cube does, with cubes, members and format', () => {
    expect(metaScopeOf('GET', {}, undefined)).toEqual({ members: true, extended: false, onlyViews: false, format: 'json' });
    expect(metaScopeOf('GET', { cubes: 'a, b,,a', members: 'false', extended: '', onlyViews: 'true', format: 'ndjson' }, undefined))
      .toEqual({ cubes: ['a', 'b'], members: false, extended: true, onlyViews: true, format: 'ndjson' });
    expect(metaScopeOf('GET', { cubes: ['a,b', 'c'] }, undefined).cubes).toEqual(['a', 'b', 'c']);
    // As Cube reads it: extended present, whatever it says.
    expect(metaScopeOf('GET', { extended: 'false' }, undefined).extended).toBe(true);
    expect(metaScopeOf('GET', {}, undefined, 'application/x-ndjson, */*').format).toBe('ndjson');
  });

  test('reads a POST\'s JSON body', () => {
    expect(metaScopeOf('POST', { cubes: 'ignored' }, { cubes: ['a', 'b'], members: false, extended: true }))
      .toEqual({ cubes: ['a', 'b'], members: false, extended: true, onlyViews: false, format: 'json' });
  });

  test('refuses what it can\'t read', () => {
    const bad: [string, Record<string, unknown>, unknown][] = [
      ['GET', { members: 'no' }, undefined],
      ['GET', { format: 'csv' }, undefined],
      ['POST', {}, []],
      ['POST', {}, { cubes: 'a' }],
      ['POST', {}, { cubes: [1] }],
      ['POST', {}, { limit: 1 }],
      ['POST', {}, { cubes: Array.from({ length: MAX_META_CUBES + 1 }, (_, i) => `c${i}`) }],
    ];
    bad.forEach(([method, query, body]) => expect(() => metaScopeOf(method, query, body)).toThrow(MetaScopeError));
  });
});

describe('scopedMeta', () => {
  const body = {
    cubes: [
      {
        name: 'a',
        type: 'cube',
        title: 'A',
        isVisible: true,
        public: true,
        connectedComponent: 1,
        sql: 'SELECT 1',
        fileName: 'a.yml',
        measures: [{ name: 'a.count' }],
        dimensions: [],
        joins: [{ name: 'b', relationship: 'belongsTo', sql: '{CUBE}.b = {b}.id' }],
        preAggregations: [],
      },
      { name: 'b', type: 'cube', measures: [] },
    ],
    compilerId: 'c',
  };

  test('keeps only the cubes named', () => {
    const scoped = scopedMeta(body, { cubes: ['b', 'z'], members: true, extended: false, onlyViews: false, format: 'json' });
    expect(scoped).toEqual({ cubes: [body.cubes[1]], compilerId: 'c' });
  });

  test('without members: plain meta\'s cube fields and each join\'s name and relationship', () => {
    const scoped = scopedMeta(body, { members: false, extended: false, onlyViews: false, format: 'json' });
    expect(scoped.cubes[0]).toEqual({
      name: 'a', type: 'cube', title: 'A', isVisible: true, public: true, connectedComponent: 1, joins: [{ name: 'b', relationship: 'belongsTo' }],
    });
    expect(scoped.cubes[1]).toEqual({ name: 'b', type: 'cube', joins: [] });
    // Extended: the cube's extended fields stay, its members go.
    const extended = scopedMeta(body, { members: false, extended: true, onlyViews: false, format: 'json' });
    expect(extended.cubes[0]).toMatchObject({ sql: 'SELECT 1', fileName: 'a.yml', joins: body.cubes[0].joins });
    expect(extended.cubes[0].measures).toBeUndefined();
    expect(extended.cubes[0].preAggregations).toBeUndefined();
  });

  test('leaves an answer that isn\'t meta as it is', () => {
    expect(scopedMeta({ error: 'x' }, { cubes: ['a'], members: false, extended: false, onlyViews: false, format: 'json' })).toEqual({ error: 'x' });
  });
});
