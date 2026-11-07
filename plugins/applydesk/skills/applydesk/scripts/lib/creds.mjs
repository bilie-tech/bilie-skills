// Passwords ApplyDesk itself creates (e.g. a Workday candidate account per
// employer) live in the OS keychain: Windows Credential Manager or macOS
// Keychain. They are typed into the page by script; no command ever prints one.
// Client LinkedIn passwords are never stored at all — clients type them.
import { randomBytes } from 'node:crypto';
import { need } from './deps.mjs';

const SERVICE = 'applydesk';
const account = (client, host) => `${client}@${String(host).toLowerCase().replace(/^https?:\/\//, '').split('/')[0]}`;

export function generatePassword() {
  // 20 chars with upper, lower, digit and symbol: passes common ATS rules.
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%*+-=?@'];
  const all = sets.join('');
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b, i) => (i < 4 ? sets[i][b % sets[i].length] : all[b % all.length]));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function store(client, host, password) {
  const { Entry } = need('@napi-rs/keyring');
  new Entry(SERVICE, account(client, host)).setPassword(password);
}

export function exists(client, host) {
  const { Entry } = need('@napi-rs/keyring');
  try {
    return Boolean(new Entry(SERVICE, account(client, host)).getPassword());
  } catch {
    return false;
  }
}

// Returns the secret for in-process use only. Never log or print the result.
export function reveal(client, host) {
  const { Entry } = need('@napi-rs/keyring');
  const p = new Entry(SERVICE, account(client, host)).getPassword();
  if (!p) throw new Error(`No stored password for ${account(client, host)}`);
  return p;
}

export function forget(client, host) {
  const { Entry } = need('@napi-rs/keyring');
  try {
    new Entry(SERVICE, account(client, host)).deletePassword();
  } catch {}
}
