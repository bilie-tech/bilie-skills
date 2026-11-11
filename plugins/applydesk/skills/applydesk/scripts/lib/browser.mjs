// Real Chrome/Edge windows, one per profile, that stay open between commands.
//
// `openProfile` starts the installed browser with its own --user-data-dir and a
// DevTools port bound to 127.0.0.1; each command then attaches over CDP, does
// its work and detaches, leaving the window (and any half-filled form) open.
// Chrome encrypts the profile's cookies with this machine's key, so a profile
// folder copied elsewhere is useless — which is what keeps sessions pinned.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, paths, readJson, writeJson, UserError } from './config.mjs';
import { need } from './deps.mjs';

export function findBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.APPLYDESK_BROWSER) return env.APPLYDESK_BROWSER;
  const candidates = [];
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    candidates.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.filter(Boolean).find((p) => exists(p)) || null;
}

const stateFile = (profile) => paths.state('browsers', `${profile}.json`);

// A busy browser can take a few seconds to answer; two tries before calling it gone.
async function alive(port, tries = 2) {
  if (!port) return false;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

function portFile(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort');
  return existsSync(file) ? Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]) || null : null;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

async function waitForPort(userDataDir, timeoutMs = 20000) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
      if (port && (await alive(port))) return port;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function openProfile(profile, { url = 'about:blank' } = {}) {
  const st = readJson(stateFile(profile));
  if (st && (await alive(st.port))) return st;
  const userDataDir = ensureDir(paths.profile(profile));

  // The window may still be open on a port we did not record: reconnect to it.
  const port0 = portFile(userDataDir);
  if (port0 && port0 !== st?.port && (await alive(port0))) {
    const again = { ...(st || {}), profile, port: port0, reconnectedAt: new Date().toISOString() };
    writeJson(stateFile(profile), again);
    return again;
  }
  // Still running but no longer answering (e.g. after a timeout): close it cleanly,
  // or a new start would just hand over to it and never open a port.
  if (st?.pid && pidAlive(st.pid)) {
    killTree(st.pid);
    for (let i = 0; i < 20 && pidAlive(st.pid); i++) await new Promise((r) => setTimeout(r, 250));
  }

  const exe = findBrowser();
  if (!exe) throw new UserError('No Chrome or Edge found. Install Google Chrome, or set APPLYDESK_BROWSER to the browser path.');
  rmSync(join(userDataDir, 'DevToolsActivePort'), { force: true });
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
  ];
  if (process.env.APPLYDESK_HEADLESS === '1') args.push('--headless=new');
  args.push(url);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const port = await waitForPort(userDataDir);
  if (!port) {
    throw new UserError(
      `ApplyDesk could not open or reach the browser window for "${profile}". A window for it is probably still open but no longer connected. Close that window (check the taskbar for a second Chrome or Edge window), then run the same command again.`,
    );
  }
  const state = { profile, port, pid: child.pid, exe, startedAt: new Date().toISOString() };
  writeJson(stateFile(profile), state);
  return state;
}

// Attach, run fn(context), detach. The browser window stays open.
export async function withProfile(profile, fn, opts = {}) {
  const { chromium } = need('playwright-core');
  const st = await openProfile(profile, opts);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${st.port}`);
  try {
    const context = browser.contexts()[0];
    return await fn(context, browser);
  } finally {
    await browser.close().catch(() => {}); // detaches only; Chrome keeps running
  }
}

export async function closeProfile(profile) {
  const st = readJson(stateFile(profile));
  if (!st) return false;
  if (await alive(st.port)) {
    const { chromium } = need('playwright-core');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${st.port}`);
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
  }
  rmSync(stateFile(profile), { force: true });
  return true;
}

export async function listOpen() {
  const dir = paths.state('browsers');
  if (!existsSync(dir)) return [];
  const { readdirSync } = await import('node:fs');
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const st = readJson(join(dir, f));
    out.push({ profile: st.profile, open: await alive(st.port) });
  }
  return out;
}

// The tab to work in: the one already showing `match`, else the newest real
// page (a fresh window's blank start tab doesn't count).
export async function pickPage(context, match) {
  const pages = context.pages();
  if (match) {
    const hit = pages.find((p) => p.url().includes(match));
    if (hit) return hit;
  }
  const real = pages.filter((p) => !/^(about:blank|chrome:\/\/|edge:\/\/)/.test(p.url()));
  return real[real.length - 1] || pages[pages.length - 1] || (await context.newPage());
}
