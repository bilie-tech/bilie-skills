// Third-party packages live in the runtime dir (installed by `doctor --fix`),
// not in the plugin folder, so plugin updates don't wipe them.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runtimeDir, UserError } from './config.mjs';

export const DEPS = {
  'playwright-core': '1.64.1',
  '@napi-rs/keyring': '2.1.2',
  docx: '9.13.0',
  mammoth: '1.13.0',
};

export function depsInstalled() {
  return Object.keys(DEPS).every((name) => existsSync(join(runtimeDir(), 'node_modules', ...name.split('/'), 'package.json')));
}

export function need(name) {
  if (!depsInstalled()) {
    throw new UserError('Runtime packages are not installed yet. Run: applydesk doctor --fix');
  }
  const require = createRequire(join(runtimeDir(), 'package.json'));
  return require(name);
}
