'use strict';

/** Cube's transpiler worker, its `extends` matched exactly (`exact-extends.js`). */
const path = require('path');
const { patchTranspiler } = require('./exact-extends');

patchTranspiler();
// eslint-disable-next-line import/no-dynamic-require
require(path.join(path.dirname(require.resolve('@cubejs-backend/schema-compiler/package.json')), 'dist/src/compiler/transpilers/transpiler_worker'));
