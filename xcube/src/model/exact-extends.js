'use strict';

/**
 * Cube's `extends`, matched as the cube's own key only.
 *
 * Cube's transpiler turns a cube's `extends: other` into a function that
 * resolves the other cube (`CubePropContextTranspiler.knownIdentifiersInjectVisitor`).
 * It finds the key with `name.match('extends')`: a substring test, at every
 * depth of the cube's definition. A member, a pre-aggregation or any nested
 * key whose name holds "extends" (`xextendsy`, `extends_at`) is wrapped as
 * `() => ({…})`, and Cube's validator then refuses the whole model. Here the
 * key is matched exactly, and only on the definition `cube()` or `view()` is
 * given, which is where `extends` means anything. YAML's own step before it
 * (`YamlCompiler.transpileYaml`) reads a key named exactly `extends` at any
 * depth as the cube's; it does so only for the cube's own key here.
 *
 * Cube transpiles a model's JavaScript (YAML's too, once it is turned into
 * JavaScript) in a pool of worker threads, each loading its own copy of the
 * transpiler: the pool is pointed at `transpile-worker.js`, which patches
 * its copy and then loads Cube's worker. Plain JavaScript, so that a worker
 * loads it as it is, built or not. Cube's native transpiler
 * (`CUBEJS_TRANSPILATION_NATIVE`) is its own and isn't patched.
 */
const path = require('path');

const COMPILER = path.dirname(require.resolve('@cubejs-backend/schema-compiler/package.json'));

/** The worker xcube's pool runs in place of Cube's transpiler worker. */
const WORKER = path.join(__dirname, 'transpile-worker.js');

/** Whether an object property is a key of the definition `cube()` or `view()` is given. */
function onDefinition(propertyPath) {
  const object = propertyPath.parentPath;
  const call = object && object.parentPath;
  return Boolean(object && object.isObjectExpression() && call && call.isCallExpression()
    && call.node.callee.type === 'Identifier' && (call.node.callee.name === 'cube' || call.node.callee.name === 'view'));
}

/** Patches this thread's copy of Cube's transpiler; once. */
function patchTranspiler() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { CubePropContextTranspiler } = require(path.join(COMPILER, 'dist/src/compiler/transpilers/CubePropContextTranspiler'));
  if (CubePropContextTranspiler.prototype.xcubeExactExtends) {
    return;
  }
  CubePropContextTranspiler.prototype.knownIdentifiersInjectVisitor = function knownIdentifiersInjectVisitor(field, resolveSymbol) {
    return {
      ObjectProperty: (propertyPath) => {
        const { key } = propertyPath.node;
        const named = (key.type === 'Identifier' && key.name === field) || (key.type === 'StringLiteral' && key.value === field);
        if (named && onDefinition(propertyPath)) {
          this.transformObjectProperty(propertyPath, resolveSymbol);
        }
      },
    };
  };
  CubePropContextTranspiler.prototype.xcubeExactExtends = true;

  // YAML's own step (`YamlCompiler.transpileYaml`) reads any key named `extends`, at any depth, as
  // the cube's. Below the cube's own keys it is walked as any other key, under a stand-in segment
  // of its path that every member-name pattern still matches; the key itself is left as it is.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { YamlCompiler } = require(path.join(COMPILER, 'dist/src/compiler/YamlCompiler'));
  const { transpileYaml } = YamlCompiler.prototype;
  YamlCompiler.prototype.transpileYaml = function xcubeTranspileYaml(obj, propertyPath, cubeName, errorsReport) {
    const nested = propertyPath.length > 1 && propertyPath[propertyPath.length - 1] === 'extends';
    return transpileYaml.call(this, obj, nested ? [...propertyPath.slice(0, -1), 'xcube_extends_key'] : propertyPath, cubeName, errorsReport);
  };
}

/**
 * Patches the main thread's transpiler, and points the worker pools Cube's
 * compiler makes for its transpiler at `WORKER`; once.
 */
function installExactExtends() {
  patchTranspiler();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const workerpool = require(require.resolve('workerpool', { paths: [COMPILER] }));
  if (workerpool.xcubeExactExtends) {
    return;
  }
  const { pool } = workerpool;
  workerpool.pool = function xcubePool(script, options) {
    const cubes = typeof script === 'string' && /[\\/]transpilers[\\/]transpiler_worker(\.js)?$/.test(script);
    return pool.call(this, cubes ? WORKER : script, options);
  };
  workerpool.xcubeExactExtends = true;
}

module.exports = { WORKER, installExactExtends, patchTranspiler };
