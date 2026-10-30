/**
 * Builds with every variable under the given prefixes, or matching the given
 * patterns, out of the environment, put back before anything else runs:
 * Cube's drivers read their settings from it in their constructors, where a
 * connection's own fields are all they should see. Stand-ins are set while it builds, where a constructor would
 * otherwise read a deprecated variable and log so on every build; the config
 * replaces each.
 */
export function withoutEnv<T>(prefixes: Array<string | RegExp>, standIns: Record<string, string>, build: () => T): T {
  const hidden = Object.entries(process.env)
    .filter(([key]) => prefixes.some((prefix) => (typeof prefix === 'string' ? key.startsWith(prefix) : prefix.test(key))));
  for (const [key] of hidden) {
    delete process.env[key];
  }
  Object.assign(process.env, standIns);
  try {
    return build();
  } finally {
    for (const key of Object.keys(standIns)) {
      delete process.env[key];
    }
    for (const [key, value] of hidden) {
      process.env[key] = value;
    }
  }
}
