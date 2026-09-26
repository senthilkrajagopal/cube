import { cubesOfQuery, type ModuleIndex, XcubeRuntime } from '../../src/runtime/runtime';
import type { XcubeSettings } from '../../src/runtime/settings';

const index = (modules: Record<string, { members: string[]; copies?: string[] }>): ModuleIndex => {
  const result: ModuleIndex = { single: false, holders: new Map(), owner: new Map(), modules: new Map() };
  for (const [id, { members, copies = [] }] of Object.entries(modules)) {
    result.modules.set(id, { files: [...members, ...copies].map((n) => ({ path: `${n}.yml`, content: '' })) });
    [...members, ...copies].forEach((n) => result.holders.set(n, (result.holders.get(n) ?? new Set()).add(id)));
    members.forEach((n) => result.owner.set(n, id));
  }
  return result;
};

const settings = {
  databaseUrl: 'postgres://unused',
  schema: 'xcube',
  migrate: true,
  pollIntervalMs: 60000,
  pollIntervalDownMs: 10000,
  retireGraceMs: 1000,
  keepRevisions: 50,
  limits: {
    maxBytes: 1048576,
    maxFileBytes: 1048576,
    maxFiles: 100,
    fileTypes: 'yaml',
  },
  compileQueue: 4,
  compileWaitMs: 60000,
  catchUpMs: 1000,
  adminTokens: [],
  maxModels: 100,
  modules: { packMin: 1, packMax: 300 },
} as XcubeSettings;

describe('cubesOfQuery', () => {
  test('reads every place a query names a member', () => {
    expect([...cubesOfQuery({
      measures: ['a.count'],
      dimensions: ['b.city'],
      segments: ['c.big'],
      timeDimensions: [{ dimension: 'd.created_at', granularity: 'day' }],
      filters: [{ member: 'e.x', operator: 'set' }, { or: [{ dimension: 'f.y' }, { and: [{ member: 'g.z' }] }] }],
      order: { 'h.v': 'asc' },
    })].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect([...cubesOfQuery({ measures: [{ cubeName: 'x', expressionName: 'e', expression: '' }], order: [['y.a', 'desc']] })].sort())
      .toEqual(['x', 'y']);
    expect([...cubesOfQuery([{ measures: ['a.c'] }, { measures: ['b.c'] }])].sort()).toEqual(['a', 'b']);
    expect([...cubesOfQuery(undefined)]).toEqual([]);
  });
});

describe('moduleForQuery', () => {
  const runtime = new XcubeRuntime(settings, { listenClient: null, logger: () => undefined });
  const modules = index({
    sales: { members: ['orders', 'order_items'], copies: ['customers'] },
    marketing: { members: ['leads'], copies: ['customers'] },
    commons: { members: ['customers'] },
  });

  test('the owner of the first cube when it holds them all', () => {
    expect(runtime.moduleForQuery(modules, { measures: ['orders.total'], dimensions: ['customers.name'] })).toBe('sales');
    expect(runtime.moduleForQuery(modules, { measures: ['leads.count'], dimensions: ['customers.name'] })).toBe('marketing');
  });

  test('commons for shared cubes alone', () => {
    expect(runtime.moduleForQuery(modules, { measures: ['customers.count'] })).toBe('commons');
  });

  test('a union of the owners when no module holds them all', () => {
    expect(runtime.moduleForQuery(modules, { measures: ['orders.total', 'leads.count'] })).toBe('u:marketing+sales');
  });

  test('join hints count as named cubes', () => {
    expect(runtime.moduleForQuery(modules, { measures: ['customers.count'], joinHints: [['orders', 'customers']] })).toBe('sales');
  });

  test('modules sharing no cube get no union: the first cube\'s module, for Cube to refuse the join', () => {
    const apart = index({ a: { members: ['x'] }, b: { members: ['y'] } });
    expect(runtime.moduleForQuery(apart, { measures: ['x.c', 'y.c'] })).toBe('a');
  });

  test('nothing named: no module; an unknown name: the first cube\'s owner, for Cube to answer', () => {
    expect(runtime.moduleForQuery(modules, {})).toBeUndefined();
    expect(runtime.moduleForQuery(modules, { measures: ['orders.total', 'nope.x'] })).toBe('sales');
  });
});

describe('jobModules', () => {
  test('narrows to the modules owning the named pre-aggregations or cubes, else all', () => {
    const runtime = new XcubeRuntime(settings, { listenClient: null, logger: () => undefined });
    runtime.configure({ modelClaim: 'm', revisionClaim: 'r', withoutModel: 'disk' });
    const revision = {
      ...index({ sales: { members: ['orders'] }, marketing: { members: ['leads'] }, commons: { members: ['customers'] } }),
      key: 'k',
      model: 'dev',
      single: false,
    };
    (runtime as any).models.set('dev', { active: revision, dirty: false, waiting: [] });
    expect(runtime.jobModules({ m: 'dev' }, { preAggregations: ['orders.main', 'customers.by_name'] })).toEqual(['commons', 'sales']);
    expect(runtime.jobModules({ m: 'dev' }, { cubes: ['leads'] })).toEqual(['marketing']);
    expect(runtime.jobModules({ m: 'dev' }, {})).toEqual(['commons', 'marketing', 'sales']);
    expect(runtime.jobModules({ m: 'dev', xcubeModule: 'sales' }, {})).toBeNull();
    expect(runtime.jobModules({}, {})).toBeNull();
  });
});

describe('checkRewritten', () => {
  test('a queryRewrite may not reach cubes outside the query\'s module', () => {
    const runtime = new XcubeRuntime(settings, { listenClient: null, logger: () => undefined });
    runtime.configure({ modelClaim: 'm', revisionClaim: 'r', withoutModel: 'disk' });
    const revision = {
      ...index({ sales: { members: ['orders'], copies: ['customers'] }, commons: { members: ['customers'] } }),
      key: 'k',
      model: 'dev',
      single: false,
      state: 'active',
    };
    (runtime as any).models.set('dev', { active: revision, dirty: false, waiting: [] });
    const context = { securityContext: { m: 'dev' }, xcubeModule: 'commons' };
    expect(() => runtime.checkRewritten({ measures: ['customers.count'] }, context)).not.toThrow();
    expect(() => runtime.checkRewritten({ measures: ['customers.count'], filters: [{ member: 'orders.id', operator: 'set' }] }, context))
      .toThrow(/queryRewrite added orders/);
    expect(() => runtime.checkRewritten({ measures: ['orders.total'] }, { ...context, xcubeModule: 'sales' })).not.toThrow();
  });
});
