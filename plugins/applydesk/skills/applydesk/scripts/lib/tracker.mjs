// Application log. Always written locally as CSV (one row per application,
// the Pacten fields from the Skill Sphere process), so nothing is lost if the
// CRM is down. Pacten itself is filled through the operator's tools profile.
import { existsSync, appendFileSync } from 'node:fs';
import { ensureDir, paths } from './config.mjs';
import { dirname } from 'node:path';

export const PACTEN_FIELDS = [
  ['Client', (m, c) => c.full_name],
  ['Company', (m) => m.company],
  ['Job title', (m) => m.title],
  ['Job description', (m, c, ctx) => ctx.jdPath],
  ['Job URL', (m) => m.url],
  ['Job posted date', (m) => (m.posted_at ? `${m.posted_at.slice(0, 10)}${m.posted_date_confirmed ? '' : ' (estimated)'}` : 'unknown')],
  ['Job freshness / age', (m) => (m.age_days_when_found === null ? 'unknown' : `${Math.round(m.age_days_when_found)} days old when found`)],
  ['Freshness priority', (m) => ({ recent: 'Recent (within 14 days)', older: 'Older than 14 days', unknown: 'Unknown' })[m.freshness_priority]],
  ['Date identified', (m) => m.date_identified],
  ['Date applied', (m) => m.date_applied || ''],
  ['CV version', (m) => (m.cv_version ? `cv-${m.cv_version}.docx` : '')],
  ['Resume Worded score', (m) => m.resume_worded_score ?? `local check ${m.local_check_score ?? 'n/a'}`],
  ['Applied via', (m) => (m.easy_apply ? 'LinkedIn Easy Apply (client)' : `Employer site${m.ats && m.ats !== 'other' ? ` (${m.ats})` : ''}`)],
  ['Application status', (m) => m.status],
  ['Notes', (m) => m.notes.slice(-3).join(' | ')],
];

export function pactenRecord(meta, client, ctx = {}) {
  return Object.fromEntries(PACTEN_FIELDS.map(([k, f]) => [k, String(f(meta, client, ctx) ?? '')]));
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function appendCsv(record) {
  const file = paths.logs('applications.csv');
  ensureDir(dirname(file));
  if (!existsSync(file)) appendFileSync(file, '﻿' + Object.keys(record).map(csvCell).join(',') + '\r\n'); // BOM so Excel on Windows reads UTF-8
  appendFileSync(file, Object.values(record).map(csvCell).join(',') + '\r\n');
  return file;
}
