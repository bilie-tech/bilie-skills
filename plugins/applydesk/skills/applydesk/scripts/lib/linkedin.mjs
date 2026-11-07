// LinkedIn, only inside a client's sitting.
//
// A sitting is a block of time when the client is present (in the room or on a
// screen share). The client signs in themselves; ApplyDesk never sees or types
// their password. Inside a sitting ApplyDesk runs the client's job searches,
// reads job pages, and opens Easy Apply jobs one by one for the client to
// submit. Outside a sitting no ApplyDesk command opens LinkedIn.
//
// There is no pacing trickery here: pages load at normal speed and, if LinkedIn
// shows any security check or warning, ApplyDesk stops and hands the window to
// the person. See references/linkedin.md.
import { appendJsonl, paths, readJson, writeJson, machineId } from './config.mjs';

export const ALLOW = [
  /^https:\/\/www\.linkedin\.com\/jobs\/(search|view|collections)\b/,
  /^https:\/\/www\.linkedin\.com\/jobs\/?(\?.*)?$/,
  /^https:\/\/www\.linkedin\.com\/feed\/?(\?.*)?$/, // landing page after sign-in
  /^https:\/\/www\.linkedin\.com\/login\b/,
  /^https:\/\/www\.linkedin\.com\/my-items\/saved-jobs\b/,
];
export const NEVER = [
  /linkedin\.com\/messaging/, /linkedin\.com\/mynetwork/, /linkedin\.com\/search\/results\/(people|all|content)/,
  /linkedin\.com\/feed\/update/, /linkedin\.com\/post/, /linkedin\.com\/company\/[^/]+\/people/, /linkedin\.com\/sales/,
  /linkedin\.com\/in\//,
];
const CHECKPOINT = [/\/checkpoint\//, /\/authwall/, /\/uas\/login/, /captcha/i, /\/challenge/, /security-verification/];
const CHECKPOINT_TEXT = /let.?s do a quick security check|verify (that )?you.?re (a )?human|unusual activity|we.?ve restricted|account (has been )?restricted|confirm your identity|automated (activity|tools)/i;

export function allowed(url) {
  if (NEVER.some((re) => re.test(url))) return false;
  return ALLOW.some((re) => re.test(url));
}

export function isCheckpoint(url, text = '') {
  return CHECKPOINT.some((re) => re.test(url)) || CHECKPOINT_TEXT.test(text.slice(0, 4000));
}

export function signedIn(url) {
  return /linkedin\.com\/(feed|jobs|mynetwork|my-items|in\/)/.test(url) && !isCheckpoint(url);
}

// f_TPR=r604800 = past week; f_WT 1 on-site, 2 remote, 3 hybrid. start = paging (25 per page).
export function searchUrl({ keywords, location, remote, days = 7, start = 0 }) {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  u.searchParams.set('keywords', keywords);
  if (location) u.searchParams.set('location', location);
  u.searchParams.set('f_TPR', `r${Math.max(1, Math.min(30, days)) * 86400}`);
  const wt = { onsite: '1', remote: '2', hybrid: '3' }[remote];
  if (wt) u.searchParams.set('f_WT', wt);
  u.searchParams.set('sortBy', 'DD');
  if (start) u.searchParams.set('start', String(start));
  return u.toString();
}

export function viewUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

export function jobIdsFromHtml(html) {
  const ids = new Set();
  for (const m of html.matchAll(/(?:\/jobs\/view\/|currentJobId=|data-job-id="|data-occludable-job-id="|urn:li:jobPosting:)(\d{6,})/g)) ids.add(m[1]);
  return [...ids];
}

// "3 days ago", "Reposted 2 weeks ago", "1 hour ago" -> age in days (float).
export function ageDays(text) {
  const m = String(text || '').match(/(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (!m) return null;
  const n = Number(m[1]);
  return { minute: n / 1440, hour: n / 24, day: n, week: n * 7, month: n * 30 }[m[2].toLowerCase()];
}

// ---- sittings ----

export const SITTING_HOURS = 3;
const sittingFile = () => paths.state('sitting.json');

// The one active sitting on this machine, or null. Expired sittings end themselves.
export function activeSitting(now = Date.now()) {
  const s = readJson(sittingFile(), null);
  if (!s) return null;
  if (now - Date.parse(s.started_at) > SITTING_HOURS * 3600e3) {
    endSitting('expired', now);
    return null;
  }
  return s;
}

export function startSitting(clientId, { operator, present }, now = Date.now()) {
  const cur = activeSitting(now);
  if (cur && cur.client !== clientId) return { error: `${cur.client}'s sitting is still open. End it first: applydesk sitting end` };
  const s = cur || { client: clientId, operator, present, machine: machineId(), started_at: new Date(now).toISOString() };
  writeJson(sittingFile(), s);
  if (!cur) appendJsonl(paths.logs('sittings.jsonl'), { event: 'start', ...s });
  return { sitting: s, resumed: Boolean(cur) };
}

export function endSitting(reason = 'ended', now = Date.now()) {
  const s = readJson(sittingFile(), null);
  if (!s) return null;
  writeJson(sittingFile(), null);
  appendJsonl(paths.logs('sittings.jsonl'), { event: 'end', client: s.client, reason, minutes: Math.round((now - Date.parse(s.started_at)) / 60e3) });
  return s;
}

// null when LinkedIn work for this client may go ahead, else the reason it may not.
export function sittingProblem(clientId) {
  const s = activeSitting();
  if (!s) return `No sitting open. LinkedIn work only happens while ${clientId} is present: applydesk sitting start ${clientId} --present`;
  if (s.client !== clientId) return `The open sitting is for ${s.client}, not ${clientId}. End it first: applydesk sitting end`;
  return null;
}

// LinkedIn showed a security check: end the sitting and record it for a person to look at.
export function stopForCheck(clientId, url) {
  appendJsonl(paths.logs('incidents.jsonl'), { client: clientId, url, machine: machineId(), what: 'LinkedIn security check or warning' });
  const holds = readJson(paths.state('linkedin-holds.json'), {});
  holds[clientId] = { url, at: new Date().toISOString() };
  writeJson(paths.state('linkedin-holds.json'), holds);
  endSitting('linkedin security check');
}

export function lastHold(clientId) {
  return readJson(paths.state('linkedin-holds.json'), {})[clientId] || null;
}

export function clearHold(clientId) {
  const holds = readJson(paths.state('linkedin-holds.json'), {});
  delete holds[clientId];
  writeJson(paths.state('linkedin-holds.json'), holds);
}

export function audit(clientId, action, url, extra = {}) {
  appendJsonl(paths.logs('linkedin', `${clientId}.jsonl`), { action, url, ...extra });
}
