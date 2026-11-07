#!/usr/bin/env node
// PreToolUse guard: keeps session tokens and stored passwords out of the
// model's context. Blocks shell commands and file reads that would expose
// browser cookie stores, exported sessions, or keychain secrets.
import { fileURLToPath } from 'node:url';

export const BLOCKED_COMMANDS = [
  /\bli_at\b/i,
  /JSESSIONID/,
  /storage_?state/i,
  /[\\/](Cookies|Login Data|Web Data)(-journal)?\b/,
  /DevToolsActivePort[\s\S]*(curl|Invoke-WebRequest|iwr|wget)/i,
  /(curl|Invoke-WebRequest|iwr|wget)[\s\S]*127\.0\.0\.1:\d+\/json/i,
  /security\s+find-(generic|internet)-password/i,
  /cmdkey\s+\/list/i,
  /Get-StoredCredential|CredRead|vaultcmd/i,
  /keyring[\s\S]{0,40}get(Password)?\b/i,
  /creds\.mjs[\s\S]*reveal|reveal\(/i,
  /context\.cookies\(|\.cookies\(\)|Network\.getAllCookies|Storage\.getCookies/,
];

const BLOCKED_PATHS = [/[\\/]profiles[\\/].*[\\/](Cookies|Login Data|Web Data|Local State)$/i, /[\\/]Network[\\/]Cookies$/i];

export function verdict(event) {
  const tool = event?.tool_name || '';
  const input = event?.tool_input || {};
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(input.command || '');
    const hit = BLOCKED_COMMANDS.find((re) => re.test(cmd));
    if (hit) return `ApplyDesk guard: this command could expose session cookies or stored passwords (${hit}). Use applydesk commands instead; they never print secrets.`;
  }
  if (/^(Read|Edit|Write|Grep)$/.test(tool)) {
    const p = String(input.file_path || input.path || '');
    if (BLOCKED_PATHS.some((re) => re.test(p))) return 'ApplyDesk guard: browser profile secrets are not readable.';
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = JSON.parse(raw || '{}');
    } catch {}
    const why = verdict(event);
    if (why) {
      process.stderr.write(why + '\n');
      process.exit(2); // exit 2 = block the tool call and show the reason to the model
    }
    process.exit(0);
  });
}
