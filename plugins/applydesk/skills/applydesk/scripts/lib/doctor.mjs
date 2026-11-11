// "Do I have what I need?" — run first on every machine and after updates.
// Checks (and with --fix installs) everything ApplyDesk depends on, and
// enforces the session-safety rules before any LinkedIn work is allowed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { home, runtimeDir, ensureDir, paths, writeJson, loadOperator, VERSION, SKILL_DIR } from './config.mjs';
import { basename } from 'node:path';
import { DEPS, OPTIONAL_DEPS, depsInstalled, need } from './deps.mjs';
import { findBrowser } from './browser.mjs';

function check(name, okay, detail, fix) {
  return { name, ok: Boolean(okay), detail, ...(okay ? {} : fix ? { fix } : {}) };
}

export function installDeps() {
  const dir = ensureDir(runtimeDir());
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: 'applydesk-runtime', private: true }, null, 2));
  const specs = Object.entries({ ...DEPS, ...OPTIONAL_DEPS }).map(([n, v]) => `${n}@${v}`);
  const r = spawnSync(...npmCommand(['install', '--no-audit', '--no-fund', '--loglevel=error', ...specs]), { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || r.error?.message || '').slice(-600) };
}

// npm without `shell: true` (deprecated, DEP0190): run npm's own script with this
// Node when it sits beside it (the usual install), else npm.cmd through cmd.exe.
export function npmCommand(args, { platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(cli)) return [execPath, [cli, ...args]];
  if (platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]];
  return ['npm', args];
}

const RECOVERY = 'Keep the recovery password somewhere safe that is not this computer (print it, or save it to the Microsoft account).';
const FINISH = `Device encryption is switched on but waiting to finish: Windows needs somewhere to keep the recovery key. Either sign in to Windows with a Microsoft account (Settings > Accounts > Your info), or in a terminal opened with "Run as administrator" run: manage-bde -protectors -add C: -TPM ; manage-bde -protectors -add C: -RecoveryPassword ; manage-bde -protectors -enable C:  ${RECOVERY}`;

// Windows shell property System.Volume.BitLockerProtection, readable without admin rights.
export function bitlockerStatus(raw) {
  const v = Number(String(raw ?? '').trim());
  const known = {
    1: { on: true, detail: 'BitLocker on' },
    3: { on: true, detail: 'BitLocker encrypting (fine to use)' },
    6: { on: true, detail: 'BitLocker on (locked)' },
    2: { on: false, detail: 'BitLocker off', fix: 'Turn on Device encryption (Settings > Privacy & security > Device encryption) or BitLocker' },
    0: { on: false, detail: 'BitLocker not available on this drive', fix: 'This drive cannot be encrypted with BitLocker. Use a computer with Device encryption or BitLocker.' },
    4: { on: false, detail: 'BitLocker decrypting (being turned off)', fix: 'Encryption is being turned off. Turn Device encryption or BitLocker back on.' },
    5: { on: false, detail: 'BitLocker suspended', fix: `Encryption is paused. In a terminal opened with "Run as administrator": manage-bde -protectors -enable C:` },
    7: { on: false, detail: 'Device encryption waiting to finish (code 7)', fix: FINISH },
  };
  if (String(raw ?? '').trim() !== '' && known[v]) return known[v];
  return { on: false, detail: `unknown BitLocker state (${String(raw ?? '').trim() || 'no answer'})`, fix: `Open Settings > Privacy & security > Device encryption and check it says On. If it says it is waiting for you to sign in: ${FINISH}` };
}

// BitLocker / FileVault.
export function diskEncryption(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const drive = (process.env.SystemDrive || 'C:').replace(/\\$/, '');
      const ps = `(New-Object -ComObject Shell.Application).NameSpace('${drive}\\').Self.ExtendedProperty('System.Volume.BitLockerProtection')`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return bitlockerStatus(r.stdout);
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

export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Claude Code keeps each plugin version in its own folder: .../applydesk/<version>/skills/applydesk.
export function installedVersions(skillDir = SKILL_DIR) {
  const versionDir = dirname(dirname(skillDir));
  if (!/^\d+\.\d+\.\d+$/.test(basename(versionDir))) return [];
  try {
    return readdirSync(dirname(versionDir)).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
  } catch {
    return [];
  }
}

async function latestPublished() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/plugins/applydesk/.claude-plugin/plugin.json', { signal: AbortSignal.timeout(4000) });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null;
  }
}

// Notes about the running version. Never fail the doctor: they are advice.
export async function versionNotes({ installed = installedVersions(), published } = {}) {
  const notes = [];
  const newest = installed.filter((v) => newer(v, VERSION)).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  if (newest) notes.push(`ApplyDesk ${newest} is installed but ${VERSION} is running. Start a new Claude session so the skill loads ${newest}.`);
  const pub = published === undefined ? await latestPublished() : published;
  if (pub && newer(pub, VERSION) && !newest) notes.push(`ApplyDesk ${pub} is available (running ${VERSION}). Update: claude plugin marketplace update bilie-skills, then claude plugin update applydesk@bilie-skills, then start a new session.`);
  return notes;
}

export async function doctor({ fix = false } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', major >= 20, `Node ${process.versions.node}`, 'Install Node.js 20+ (Windows: run scripts\\bootstrap.ps1)'));

  ensureDir(home());
  checks.push(check('data folder', existsSync(home()), home()));

  if (!depsInstalled(true) && fix) {
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
    enc.fix || (process.platform === 'win32' ? 'Turn on Device encryption (Settings > Privacy & security > Device encryption) or BitLocker' : 'Turn on FileVault (System Settings > Privacy & Security)')));

  const exported = findExportedSessions();
  checks.push(check('no exported sessions', exported.length === 0, exported.length ? exported.join('; ') : 'clean', 'Delete those files: sessions must stay inside browser profiles'));

  const op = loadOperator();
  checks.push(check('operator setup', op, op ? `operator ${op.id}` : 'not set up', 'Run: applydesk setup --operator <your-name>'));

  const sessionSafe = ['node', 'packages', 'browser', 'disk encryption', 'no exported sessions'].every((n) => checks.find((c) => c.name === n)?.ok);
  const notes = await versionNotes();
  const report = { at: new Date().toISOString(), version: VERSION, platform: process.platform, ready: checks.every((c) => c.ok), linkedin_allowed: sessionSafe, checks, notes };
  writeJson(paths.state('doctor.json'), report);
  return report;
}
