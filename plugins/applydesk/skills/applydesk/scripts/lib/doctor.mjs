// "Do I have what I need?" — run first on every machine and after updates.
// Checks (and with --fix installs) everything ApplyDesk depends on, and
// enforces the session-safety rules before any LinkedIn work is allowed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, runtimeDir, ensureDir, paths, writeJson, loadOperator } from './config.mjs';
import { DEPS, depsInstalled, need } from './deps.mjs';
import { findBrowser } from './browser.mjs';

function check(name, okay, detail, fix) {
  return { name, ok: Boolean(okay), detail, ...(okay ? {} : fix ? { fix } : {}) };
}

export function installDeps() {
  const dir = ensureDir(runtimeDir());
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'applydesk-runtime', private: true }, null, 2));
  const specs = Object.entries(DEPS).map(([n, v]) => `${n}@${v}`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...specs], {
    cwd: dir,
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
    encoding: 'utf8',
  });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || '').slice(-600) };
}

// BitLocker / FileVault. Windows: shell property readable without admin rights
// (1 = on, 3 = encrypting, 2 = off, 0 = not available).
export function diskEncryption(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const drive = (process.env.SystemDrive || 'C:').replace(/\\$/, '');
      const ps = `(New-Object -ComObject Shell.Application).NameSpace('${drive}\\').Self.ExtendedProperty('System.Volume.BitLockerProtection')`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
      const v = Number(String(r.stdout).trim());
      return { on: v === 1 || v === 3, detail: { 1: 'BitLocker on', 3: 'BitLocker encrypting', 2: 'BitLocker off', 0: 'BitLocker not available' }[v] || `unknown (${String(r.stdout).trim()})` };
    }
    if (platform === 'darwin') {
      const r = spawnSync('fdesetup', ['status'], { encoding: 'utf8', timeout: 10000 });
      return { on: /FileVault is On/i.test(r.stdout), detail: r.stdout.trim() };
    }
    return { on: false, detail: 'Linux: check LUKS manually' };
  } catch (e) {
    return { on: false, detail: `could not check: ${e.message}` };
  }
}

// Session tokens must never leave the browser profile. Fail if any exported
// cookie/session file exists in the ApplyDesk folder (outside profiles/).
export function findExportedSessions(root = home()) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['profiles', 'node_modules', '.runtime'].includes(e.name)) continue;
        walk(p, depth + 1);
      } else if (/\.(json|txt|har)$/i.test(e.name) && statSync(p).size < 5e6) {
        const t = readFileSync(p, 'utf8');
        if (/"li_at"|"JSESSIONID"|"cookies"\s*:\s*\[\s*\{\s*"name"|"storageState"/.test(t) || /\.har$/i.test(e.name)) hits.push(p);
      }
    }
  };
  walk(root, 0);
  return hits;
}

export async function doctor({ fix = false } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', major >= 20, `Node ${process.versions.node}`, 'Install Node.js 20+ (Windows: run scripts\\bootstrap.ps1)'));

  ensureDir(home());
  checks.push(check('data folder', existsSync(home()), home()));

  if (!depsInstalled() && fix) {
    const r = installDeps();
    checks.push(check('install packages', r.ok, r.ok ? `installed into ${runtimeDir()}` : r.output, 'Check internet access / npm proxy settings'));
  }
  checks.push(check('packages', depsInstalled(), Object.keys(DEPS).join(', '), 'Run: applydesk doctor --fix'));

  const browser = findBrowser();
  checks.push(check('browser', browser, browser || 'none found', 'Install Google Chrome (or set APPLYDESK_BROWSER)'));

  if (depsInstalled()) {
    try {
      const { Entry } = need('@napi-rs/keyring');
      const e = new Entry('applydesk', 'doctor-probe');
      e.setPassword('probe');
      const got = e.getPassword();
      e.deletePassword();
      checks.push(check('keychain', got === 'probe', process.platform === 'win32' ? 'Windows Credential Manager' : process.platform === 'darwin' ? 'macOS Keychain' : 'Secret Service'));
    } catch (e) {
      checks.push(check('keychain', false, e.message, 'Unlock the OS keychain / sign in to Windows normally'));
    }
  }

  const enc = diskEncryption();
  const allowUnencrypted = process.env.APPLYDESK_ALLOW_UNENCRYPTED === '1';
  checks.push(check('disk encryption', enc.on || allowUnencrypted, enc.detail + (allowUnencrypted && !enc.on ? ' (override set: TEST ONLY)' : ''),
    process.platform === 'win32' ? 'Turn on BitLocker / Device encryption (Settings > Privacy & security > Device encryption)' : 'Turn on FileVault (System Settings > Privacy & Security)'));

  const exported = findExportedSessions();
  checks.push(check('no exported sessions', exported.length === 0, exported.length ? exported.join('; ') : 'clean', 'Delete those files: sessions must stay inside browser profiles'));

  const op = loadOperator();
  checks.push(check('operator setup', op, op ? `operator ${op.id}` : 'not set up', 'Run: applydesk setup --operator <your-name>'));

  const sessionSafe = ['node', 'packages', 'browser', 'disk encryption', 'no exported sessions'].every((n) => checks.find((c) => c.name === n)?.ok);
  const report = { at: new Date().toISOString(), platform: process.platform, ready: checks.every((c) => c.ok), linkedin_allowed: sessionSafe, checks };
  writeJson(paths.state('doctor.json'), report);
  return report;
}
