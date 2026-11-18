/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // As Cube's own, to keep the vendored scaffolder's snapshots as they are.
  snapshotFormat: {
    escapeString: true,
    printBasicPrototype: true,
  },
  // thrift's (hive-driver's) uuid 13 is an ES module only, which Jest's runtime can't load (Node
  // does): uuid is Cube's, whose CommonJS build has the parse and stringify thrift calls.
  moduleNameMapper: { '^uuid$': '<rootDir>/node_modules/uuid/dist/cjs/index.js' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
};
