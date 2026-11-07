// One folder per job per client. meta.json carries the Pacten fields from the
// Skill Sphere process (company, title, URL, posted date, freshness, dates,
// CV version, score, status, notes) so logging is a straight copy.
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, paths, readJson, writeJson, slug, today } from './config.mjs';
import { detectAts } from './ats.mjs';

export const STATUSES = ['found', 'skipped', 'jd_ready', 'cv_ready', 'with_client', 'filling', 'ready_for_review', 'applied', 'interview', 'assessment', 'offer', 'rejected', 'withdrawn'];

const indexFile = (clientId) => join(paths.jobs(clientId), 'index.json');

export function freshness(postedAt, now = Date.now()) {
  if (!postedAt) return { age_days: null, priority: 'unknown' };
  const age = Math.max(0, (now - Date.parse(postedAt)) / 864e5);
  return { age_days: Math.round(age * 10) / 10, priority: age <= 14 ? 'recent' : 'older' };
}

export function addJob(clientId, job) {
  const idx = readJson(indexFile(clientId), {});
  const key = `${job.source}:${job.external_id || job.url}`;
  if (idx[key]) return { jobId: idx[key], created: false };
  const jobId = `${today()}-${slug(job.company, 20)}-${slug(job.title, 30)}`;
  let unique = jobId;
  for (let i = 2; existsSync(paths.job(clientId, unique)); i++) unique = `${jobId}-${i}`;
  const dir = ensureDir(paths.job(clientId, unique));
  const fr = freshness(job.posted_at);
  const meta = {
    job_id: unique,
    client: clientId,
    company: job.company || '',
    title: job.title || '',
    location: job.location || '',
    url: job.url || '',
    apply_url: job.apply_url || (job.source !== 'linkedin' ? job.url : ''),
    ats: detectAts(job.apply_url || job.url),
    easy_apply: Boolean(job.easy_apply),
    source: job.source,
    external_id: job.external_id || null,
    posted_at: job.posted_at || null,
    posted_date_confirmed: Boolean(job.posted_at && job.posted_exact),
    age_days_when_found: fr.age_days,
    freshness_priority: fr.priority,
    date_identified: today(),
    date_applied: null,
    cv_version: null,
    local_check_score: null,
    resume_worded_score: null,
    status: job.description ? 'jd_ready' : 'found',
    notes: [],
  };
  writeJson(join(dir, 'meta.json'), meta);
  if (job.description) writeFileSync(join(dir, 'jd.md'), `# ${meta.title} — ${meta.company}\n\n${job.description}\n`);
  idx[key] = unique;
  writeJson(indexFile(clientId), idx);
  return { jobId: unique, created: true };
}

export function getJob(clientId, jobId) {
  const meta = readJson(join(paths.job(clientId, jobId), 'meta.json'));
  if (!meta) throw new Error(`No job ${jobId} for client ${clientId}`);
  return meta;
}

export function updateJob(clientId, jobId, patch, note) {
  const meta = getJob(clientId, jobId);
  Object.assign(meta, patch);
  if (note) meta.notes.push(`${new Date().toISOString().slice(0, 16)} ${note}`);
  writeJson(join(paths.job(clientId, jobId), 'meta.json'), meta);
  return meta;
}

export function listJobs(clientId, status) {
  const dir = paths.jobs(clientId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson(join(dir, d.name, 'meta.json')))
    .filter(Boolean)
    .filter((m) => !status || m.status === status)
    .sort((a, b) => (a.freshness_priority === b.freshness_priority ? (a.age_days_when_found ?? 99) - (b.age_days_when_found ?? 99) : a.freshness_priority === 'recent' ? -1 : 1));
}

export function readJd(clientId, jobId) {
  const f = join(paths.job(clientId, jobId), 'jd.md');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export function latestCv(clientId, jobId) {
  const dir = paths.job(clientId, jobId);
  const versions = readdirSync(dir)
    .map((f) => f.match(/^cv-(\d+)\.md$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  return versions.length ? { version: versions[0], md: join(dir, `cv-${versions[0]}.md`), docx: join(dir, `cv-${versions[0]}.docx`) } : null;
}
