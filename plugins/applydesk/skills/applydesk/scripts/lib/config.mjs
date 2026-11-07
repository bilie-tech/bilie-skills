// Paths, ids and small file helpers shared by every ApplyDesk command.
// No third-party imports here: tests and the doctor run before deps exist.
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = dirname(SCRIPTS_DIR);

export function home() {
  return process.env.APPLYDESK_HOME || join(homedir(), 'ApplyDesk');
}

export function runtimeDir() {
  return process.env.APPLYDESK_RUNTIME || join(home(), '.runtime');
}

export const paths = {
  operator: () => join(home(), 'operator.json'),
  clients: () => join(home(), 'clients'),
  client: (id) => join(home(), 'clients', id),
  clientFile: (id) => join(home(), 'clients', id, 'client.json'),
  jobs: (id) => join(home(), 'clients', id, 'jobs'),
  job: (id, jobId) => join(home(), 'clients', id, 'jobs', jobId),
  profiles: () => join(home(), 'profiles'),
  profile: (name) => join(home(), 'profiles', name),
  state: (...p) => join(home(), 'state', ...p),
  logs: (...p) => join(home(), 'logs', ...p),
};

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function readJson(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Write via a temp file and rename so a crash never leaves half a JSON file.
export function writeJson(file, data) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
  return file;
}

export function appendJsonl(file, record) {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
}

export function slug(s, max = 40) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '') || 'x';
}

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function machineId() {
  return process.env.APPLYDESK_MACHINE_ID || hostname().toLowerCase();
}

// Two browser profiles per client: one holds their LinkedIn sign-in and is only
// opened during a sitting; the other is for employer sites and staff work.
export function linkedinProfileName(clientId) {
  return `li-${slug(clientId)}`;
}

export function applyProfileName(clientId) {
  return `apply-${slug(clientId)}`;
}

export function toolsProfileName(operatorId) {
  return `tools-${slug(operatorId)}`;
}

export function loadClient(id) {
  const c = readJson(paths.clientFile(id));
  if (!c) throw new UserError(`No client "${id}". Run: applydesk client list`);
  return c;
}

export function loadOperator() {
  return readJson(paths.operator(), null);
}

export class UserError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}
