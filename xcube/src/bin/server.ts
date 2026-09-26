#!/usr/bin/env node
/**
 * Starts Cube as `cubejs server` does (production mode, the configuration
 * and data model from the working directory), with the introspection routes,
 * and with xcube's runtime when `XCUBE_DATABASE_URL` is set.
 * Pass `--debug` for Cube's debug output.
 */
import { setGlobalRuntime } from '../config';
import { XcubeRuntime } from '../runtime/runtime';
import { settingsFromEnv } from '../runtime/settings';
import { XcubeServerContainer } from '../server';

/**
 * The package extends Cube through protected methods that can change in any
 * release, so it runs only on the Cube it was built for.
 */
function assertCubeVersion() {
  // eslint-disable-next-line global-require,import/no-dynamic-require
  const expected: string = require('../../../package.json').peerDependencies['@cubejs-backend/server-core'];
  // eslint-disable-next-line global-require
  const { version } = require('@cubejs-backend/server-core/package.json');

  if (version !== expected) {
    throw new Error(
      `xcube is built for Cube ${expected}, but this is Cube ${version}. ` +
      'Build the package against this version of Cube.'
    );
  }
}

async function main() {
  assertCubeVersion();
  process.env.NODE_ENV = 'production';
  // Each compile's transpiler pool; unset, a compile can take gigabytes.
  process.env.CUBEJS_TRANSPILATION_WORKER_THREADS_COUNT ??= '2';

  const settings = settingsFromEnv();
  if (settings) {
    // Before Cube loads cube.js, whose require('xcube').config() needs it.
    const runtime = new XcubeRuntime(settings);
    setGlobalRuntime(runtime);
    await runtime.start();
  }

  const container = new XcubeServerContainer({
    debug: process.argv.includes('--debug'),
  });
  await container.runProjectDiagnostics();
  await container.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
