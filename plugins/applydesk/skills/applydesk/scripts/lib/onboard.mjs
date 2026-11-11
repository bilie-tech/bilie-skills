// Client onboarding form: a one-page web form served on 127.0.0.1 with a
// one-time token. The operator fills in what they know (only the ID and name are
// required) and clicks Save; the server writes client.json + the master CV, then
// exits. The rest is added later with `client edit`, or one field at a time with
// `client set`.
//
// The form runs in its own background process (`client serve`) so the command
// that opens it returns at once with the address. Everything typed is saved as a
// draft on this computer, the form stays open while it is being used, and
// reopening it brings the draft back.
// No passwords are collected: the client signs in to LinkedIn themselves, in a sitting.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, paths, readJson, writeJson, slug, SCRIPTS_DIR } from './config.mjs';
import { docxToMarkdown, pdfToMarkdown } from './docs.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- field rules (shared by the form, `client set` and the server) ----------

// Common job-title words, to catch typos like "Enginer" that would wreck a search.
export const TITLE_WORDS = ('engineer engineering developer software analyst analytics data scientist science manager management director ' +
  'designer design product project program programme marketing sales account accountant accounting executive officer assistant associate ' +
  'specialist coordinator consultant administrator administrative technician representative support customer success operations ' +
  'business finance financial controller auditor architect lead senior junior principal staff intern head chief vice president ' +
  'nurse teacher instructor tutor recruiter recruitment human resources people talent advisor adviser agent clerk receptionist ' +
  'cashier driver warehouse logistics supply chain procurement buyer planner scheduler supervisor foreman electrician plumber ' +
  'mechanic machinist welder carpenter labourer laborer cook chef server bartender barista security guard cleaner janitor ' +
  'therapist pharmacist physician doctor dentist hygienist paramedic caregiver worker social researcher research writer editor ' +
  'content communications public relations graphic web frontend backend stack mobile cloud devops network systems security ' +
  'quality assurance tester test automation machine learning artificial intelligence full general legal paralegal lawyer counsel ' +
  'compliance risk insurance underwriter claims banking bank teller investment portfolio economist statistician actuary health ' +
  'healthcare medical clinical laboratory lab biologist chemist environmental civil mechanical electrical industrial manufacturing ' +
  'production maintenance facilities property real estate leasing hospitality travel event events retail store merchandiser ' +
  'ecommerce digital social media brand growth partnerships partner relationship development training learning education ' +
  'administration office front desk entry level remote hybrid part time contract freelance bookkeeper payroll tax analyst ' +
  'associate coordinator generalist strategist strategy solutions implementation integration infrastructure platform site reliability ' +
  'database dba erp sap salesforce crm power excel'
).split(/\s+/);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Two letters swapped ("anaylst") is one typo, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

// "Did you mean Engineer?" for words one or two letters off a common title word.
export function titleWarnings(titles, words = TITLE_WORDS) {
  const out = [];
  for (const t of [].concat(titles || [])) {
    for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) {
      if (w.length < 5 || words.includes(w)) continue;
      const near = words.filter((x) => Math.abs(x.length - w.length) <= 2 && lev(w, x) <= (w.length >= 8 ? 2 : 1));
      if (near.length) out.push(`"${w}" in "${t}": did you mean "${near[0]}"?`);
    }
  }
  return out;
}

export function normalizeLinkedin(raw) {
  let v = String(raw || '').trim();
  if (!v) return { value: null };
  if (!/^https?:\/\//i.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(v);
  } catch {
    return { error: 'That is not a web address. Example: linkedin.com/in/jane-doe' };
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/in\/[^/]+/i.test(u.pathname)) {
    return { error: 'Use the client\'s LinkedIn profile address, like linkedin.com/in/jane-doe' };
  }
  return { value: `https://www.linkedin.com${u.pathname.replace(/\/+$/, '')}` };
}

// Every country name the browser knows, in English (the names employer forms use).
let countriesCache;
export function countryList() {
  if (countriesCache) return countriesCache;
  const dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const skip = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);
  const names = [];
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = !skip.has(code) && dn.of(code);
      if (name && name !== code) names.push(name);
    }
  countriesCache = [...new Set(names)].sort((x, y) => x.localeCompare(y));
  return countriesCache;
}

const COUNTRY_ALIASES = {
  usa: 'United States', us: 'United States', america: 'United States', 'united states of america': 'United States', 'united state of america': 'United States', 'united state': 'United States',
  uk: 'United Kingdom', 'great britain': 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom',
  uae: 'United Arab Emirates', 'south korea': 'South Korea', korea: 'South Korea', holland: 'Netherlands',
};

export function matchCountry(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const list = countryList();
  const k = v.toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ');
  if (COUNTRY_ALIASES[k]) return COUNTRY_ALIASES[k];
  return list.find((c) => c.toLowerCase() === k) || list.find((c) => lev(c.toLowerCase(), k) <= 2) || null;
}

export function timezones() {
  return Intl.supportedValuesOf('timeZone');
}

const TZ_ALIASES = {
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver', mountain: 'America/Denver',
  cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago', central: 'America/Chicago',
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York', eastern: 'America/New_York',
  ast: 'America/Halifax', adt: 'America/Halifax', nst: 'America/St_Johns', ndt: 'America/St_Johns',
  gmt: 'Europe/London', bst: 'Europe/London', utc: 'UTC', wat: 'Africa/Lagos', cet: 'Europe/Paris', cest: 'Europe/Paris',
  eat: 'Africa/Nairobi', ist: 'Asia/Kolkata', aest: 'Australia/Sydney',
};

export function matchTimezone(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const zones = timezones();
  if (zones.includes(v)) return v;
  const lower = v.toLowerCase();
  const exact = zones.find((z) => z.toLowerCase() === lower.replace(/\s+/g, '_'));
  if (exact) return exact;
  const abbr = lower.match(/^[a-z]+/)?.[0];
  return (abbr && TZ_ALIASES[abbr]) || null;
}

const list = (s) => (Array.isArray(s) ? s : String(s || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const text = (s) => String(s ?? '').trim() || null;
const YES = /^(y|yes|true|1)$/i;
const NO = /^(n|no|false|0)$/i;

// key -> kind. `client set` accepts exactly these.
export const FIELDS = {
  full_name: 'text', email: 'email', phone: 'text', address: 'text', city: 'city', region: 'text', country: 'country', postal_code: 'text',
  linkedin_url: 'linkedin', website: 'text', current_company: 'text',
  target_titles: 'titles', seniority: ['entry', 'mid', 'senior', 'lead', 'director'], industries: 'list', locations: 'list',
  remote: ['any', 'remote', 'hybrid', 'onsite'], salary_min: 'number', currency: 'text', salary_answer: 'text',
  preferred_employers: 'list', excluded_employers: 'list', excluded_keywords: 'list', max_age_days: 'number',
  work_authorized: 'yesno', needs_sponsorship: 'yesno', willing_to_relocate: 'yesno', availability: 'text', considerations: 'text', timezone: 'timezone',
};

// One field, checked the same way everywhere. -> { value, error?, warnings: [] }
export function normalizeField(key, raw) {
  const kind = FIELDS[key];
  const warnings = [];
  if (!kind) return { error: `Unknown field "${key}". Fields: ${Object.keys(FIELDS).join(', ')}`, warnings };
  if (Array.isArray(kind)) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v) return { value: null, warnings };
    return kind.includes(v) ? { value: v, warnings } : { error: `${key} must be one of: ${kind.join(', ')}`, warnings };
  }
  switch (kind) {
    case 'text':
      return { value: text(raw), warnings };
    case 'email': {
      const v = text(raw);
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'That email address does not look right', warnings };
      return { value: v, warnings };
    }
    case 'city': {
      const v = text(raw);
      if (v && (/\d/.test(v) || v.split(',').length > 2)) warnings.push(`City "${v}" looks like a street address. Put the street in Address and only the city here.`);
      return { value: v, warnings };
    }
    case 'country': {
      if (!text(raw)) return { value: null, warnings };
      const v = matchCountry(raw);
      if (!v) return { error: `"${raw}" is not a country name ApplyDesk knows. Pick it from the list (e.g. United States, Canada).`, warnings };
      if (v !== String(raw).trim()) warnings.push(`Country saved as "${v}"`);
      return { value: v, warnings };
    }
    case 'timezone': {
      if (!text(raw)) return { value: null, warnings };
      const v = matchTimezone(raw);
      if (!v) return { error: `"${raw}" is not a time zone name. Use one like America/Los_Angeles or Europe/London.`, warnings };
      if (v !== String(raw).trim()) warnings.push(`Time zone saved as "${v}"`);
      return { value: v, warnings };
    }
    case 'linkedin': {
      const r = normalizeLinkedin(raw);
      return { ...r, warnings };
    }
    case 'titles': {
      const v = list(raw);
      warnings.push(...titleWarnings(v));
      return { value: v, warnings };
    }
    case 'list':
      return { value: list(raw), warnings };
    case 'number': {
      const s = String(raw ?? '').replace(/[,\s$]/g, '');
      if (!s) return { value: null, warnings };
      return Number.isFinite(Number(s)) ? { value: Number(s), warnings } : { error: `${key} must be a number`, warnings };
    }
    case 'yesno': {
      const s = String(raw ?? '').trim();
      if (!s || /^(unknown|not asked( yet)?|-)$/i.test(s)) return { value: null, warnings };
      if (YES.test(s)) return { value: true, warnings };
      if (NO.test(s)) return { value: false, warnings };
      return { error: `${key} must be yes, no or unknown`, warnings };
    }
  }
  return { value: text(raw), warnings };
}

export class FormError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.errors = errors;
  }
}

// What's still empty and what it blocks, so the agent can say what to ask the client for.
export const NEEDED = {
  email: 'employer forms', phone: 'employer forms', city: 'employer forms', country: 'employer forms',
  linkedin_url: 'employer forms', target_titles: 'job searches', master_cv: 'tailored CVs',
  consent_linkedin: 'LinkedIn sittings', consent_cv_upload: 'Resume Worded scores',
};

export function missingInfo(c) {
  const has = {
    email: c.email, phone: c.phone, city: c.city, country: c.country, linkedin_url: c.linkedin_url,
    target_titles: c.target_titles?.length, master_cv: c.master_cv,
    consent_linkedin: c.consent?.linkedin_session, consent_cv_upload: c.consent?.cv_upload,
  };
  return Object.keys(NEEDED).filter((k) => !has[k]);
}

// The form's fields -> a client. Throws FormError listing every problem at once.
export function toClient(form, existing = {}, warnings = []) {
  const errors = {};
  const id = slug(form.id || '');
  const full_name = text(form.full_name);
  if (!form.id || !id || id === 'x') errors.id = 'The client ID is required (short, no spaces, e.g. jane-doe).';
  if (!full_name) errors.full_name = 'The full name is required.';
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    if (key === 'full_name') continue;
    const r = normalizeField(key, form[key]);
    if (r.error) errors[key] = r.error;
    else out[key] = r.value;
    warnings.push(...r.warnings);
  }
  const consent = {
    linkedin_session: Boolean(form.consent_linkedin),
    cv_upload: Boolean(form.consent_cv_upload),
    inbox: Boolean(form.consent_inbox),
    privacy_notices: Boolean(form.consent_privacy_notices),
  };
  const anyConsent = Object.values(consent).some(Boolean);
  const recorded_by = text(form.consent_by);
  if (anyConsent && !recorded_by) errors.consent_by = 'Enter the operator name under "Consent recorded by".';
  if (Object.keys(errors).length) throw new FormError(errors);

  const [first, ...rest] = full_name.split(/\s+/);
  const prev = existing.consent || {};
  const same = Object.keys(consent).every((k) => Boolean(prev[k]) === consent[k]) && prev.recorded_by === recorded_by;
  return {
    ...existing,
    id,
    full_name,
    first_name: first,
    last_name: rest.join(' '),
    ...out,
    remote: out.remote || 'any',
    max_age_days: out.max_age_days || 14,
    considerations: out.considerations || '',
    eeo_answers: existing.eeo_answers || { gender: 'decline', ethnicity: 'decline', veteran: 'decline', disability: 'decline' },
    consent: {
      ...consent,
      recorded_by,
      recorded_at: same && prev.recorded_at ? prev.recorded_at : anyConsent ? new Date().toISOString() : null,
    },
    created_at: existing.created_at || new Date().toISOString(),
  };
}

// A saved client plus an unsaved draft, in client shape, for filling the form.
export function prefill(existing = {}, draft = null) {
  if (!draft) return existing;
  const c = { ...existing, consent: { ...(existing.consent || {}) } };
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'token') continue;
    if (FIELDS[k] === 'yesno') c[k] = v === 'yes' ? true : v === 'no' ? false : null;
    else if (k.startsWith('consent_') && k !== 'consent_by') c.consent[{ consent_linkedin: 'linkedin_session' }[k] || k.slice(8)] = Boolean(v);
    else if (k === 'consent_by') c.consent.recorded_by = v;
    else c[k] = v;
  }
  for (const k of ['consent_linkedin', 'consent_cv_upload', 'consent_inbox', 'consent_privacy_notices']) {
    if (!(k in draft)) c.consent[{ consent_linkedin: 'linkedin_session' }[k] || k.slice(8)] = false;
  }
  return c;
}

// ---------- CV files ----------

// What a file really is, from its first bytes, whatever its name says.
export function sniffCv(buf) {
  const b = Buffer.from(buf.subarray ? buf.subarray(0, 8) : buf);
  if (b[0] === 0x50 && b[1] === 0x4b) return 'docx';
  if (b.toString('latin1', 0, 4) === '%PDF') return 'pdf';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'doc';
  if (b.toString('latin1', 0, 5) === '{\\rtf') return 'rtf';
  return 'unknown';
}

export const CV_PROBLEMS = {
  doc: 'This is an old Word .doc file. Open it in Word and use File > Save As > Word Document (.docx), then upload that.',
  rtf: 'This is a Rich Text (.rtf) file. Open it in Word and use File > Save As > Word Document (.docx), then upload that.',
  unknown: 'This file is not a real Word .docx or a PDF. It may be another kind of file renamed. Open it in Word and use File > Save As > Word Document (.docx).',
};

export async function saveMasterCv(dir, buf, name = '') {
  const kind = sniffCv(buf);
  if (CV_PROBLEMS[kind]) throw new FormError({ cv: CV_PROBLEMS[kind] });
  const cvDir = ensureDir(join(dir, 'cv'));
  const src = join(cvDir, `master.${kind}`);
  writeFileSync(src, buf);
  const md = join(cvDir, 'master.md');
  try {
    writeFileSync(md, kind === 'pdf' ? await pdfToMarkdown(src) : await docxToMarkdown(src));
  } catch (e) {
    if (/not installed yet/.test(e.message)) throw new FormError({ cv: e.message });
    throw new FormError({ cv: kind === 'pdf' ? `Could not read text from this PDF (${e.message}). If it is a scan, ask the client for a Word version.` : `Word could not be read: ${e.message}. Open it in Word and save it again as .docx.` });
  }
  return {
    docx: kind === 'docx' ? src : null,
    pdf: kind === 'pdf' ? src : null,
    md,
    source: kind,
    original_name: name || undefined,
    uploaded_at: new Date().toISOString(),
    ...(kind === 'pdf' ? { note: 'Converted from PDF: check master.md reads in the right order before tailoring.' } : {}),
  };
}

// ---------- the page ----------

export function formPage(token, c = {}, { expiresAt, warnings = [] } = {}) {
  const v = (k) => esc(Array.isArray(c[k]) ? c[k].join(', ') : c[k]);
  const sel = (k, opts) => opts.map(([val, label]) => `<option value="${val}" ${c[k] === val ? 'selected' : ''}>${label}</option>`).join('');
  // Yes/no answers are stored as true/false/null; null means nobody has asked yet.
  const yn = (k, first = 'yes') => {
    const cur = c[k] === true ? 'yes' : c[k] === false ? 'no' : '';
    const opts = [['', 'Not asked yet'], ...(first === 'yes' ? [['yes', 'Yes'], ['no', 'No']] : [['no', 'No'], ['yes', 'Yes']])];
    return opts.map(([val, label]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${label}</option>`).join('');
  };
  const ticked = (k) => (c.consent?.[k] ? ' checked' : '');
  const country = matchCountry(c.country) || '';
  const countryOpts = ['<option value="">Pick a country</option>', ...countryList().map((n) => `<option ${n === country ? 'selected' : ''}>${esc(n)}</option>`)].join('');
  const tz = matchTimezone(c.timezone) || (c.timezone ? '' : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tzOpts = ['<option value="">Pick a time zone</option>', ...timezones().map((z) => `<option ${z === tz ? 'selected' : ''}>${esc(z)}</option>`)].join('');
  const was = (k, matched) => (c[k] && !matched ? `<span class="warn">Saved before as "${esc(c[k])}": pick from the list</span>` : '');
  const cvNote = c.master_cv ? `one is saved (${esc(c.master_cv.source || 'docx')}); upload only to replace it` : 'Word (.docx) or PDF. Needed before CVs can be tailored';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ApplyDesk — client onboarding</title>
<style>
:root{--bg:#f6f7f6;--ink:#18201e;--muted:#56615d;--line:#d9dfdc;--accent:#0f6b5c;--warn:#8a4b08;--bad:#a1260d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 80px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px;padding-top:14px;border-top:1px solid var(--line)}
p.m{color:var(--muted);margin:0 0 12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:600px){.grid{grid-template-columns:1fr}}
label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.92rem}label span{font-weight:400;color:var(--muted);font-size:.85rem}
label span.warn,.warn{color:var(--warn)}.err{color:var(--bad);font-weight:600}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:#fff}textarea{min-height:64px}
.full{grid-column:1/-1}.check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:400}.check input{margin-top:5px}
.consent{border:1px solid var(--warn);border-radius:8px;padding:12px 14px;background:#fbeedd;display:flex;flex-direction:column;gap:10px}
#bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);font-size:.9rem;color:var(--muted);z-index:2}
#bar.late{color:var(--bad);font-weight:600}
button{margin-top:24px;font:600 1rem system-ui;padding:12px 22px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
#msg{margin-top:14px;font-weight:600;white-space:pre-line}
</style></head><body><main>
<div id="bar" role="status">Drafts save as you type.</div>
<h1>Client onboarding</h1><p class="m">Only the client ID and full name are required. Fill in what you have now and add the rest later (ask the agent to edit the client). It is saved on this computer only. Do not enter any passwords here.</p>
${warnings.length ? `<p class="warn">${warnings.map(esc).join('<br>')}</p>` : ''}
<form id="f" enctype="multipart/form-data" autocomplete="off">
<input type="hidden" name="token" value="${token}">
<h2>Who</h2><div class="grid">
<label>Client ID <span>short, no spaces, e.g. jane-doe</span><input name="id" required pattern="[a-z0-9-]{2,40}" value="${v('id')}" ${c.id ? 'readonly' : ''}></label>
<label>Full name<input name="full_name" required value="${v('full_name')}"></label>
<label>Email used for applications<input type="email" name="email" value="${v('email')}"></label>
<label>Phone<input name="phone" value="${v('phone')}"></label>
<label class="full">Street address <span>only if employer forms need it</span><input name="address" value="${v('address')}"></label>
<label>City <span>city only, e.g. San Diego</span><input name="city" value="${v('city')}"><span class="warn" id="w_city"></span></label>
<label>Province / state<input name="region" value="${v('region')}"></label>
<label>Country<select name="country">${countryOpts}</select>${was('country', country)}</label>
<label>Postal code<input name="postal_code" value="${v('postal_code')}"></label>
<label class="full">LinkedIn profile <span>e.g. linkedin.com/in/jane-doe (https:// is added for you)</span><input name="linkedin_url" inputmode="url" placeholder="linkedin.com/in/..." value="${v('linkedin_url')}"><span class="warn" id="w_linkedin_url"></span></label>
<label>Website / portfolio<input name="website" value="${v('website')}"></label>
<label>Current employer<input name="current_company" value="${v('current_company')}"></label>
</div>
<h2>What they want</h2><div class="grid">
<label class="full">Target job titles <span>comma separated, most important first. Spelling matters: these are the searches.</span><input name="target_titles" spellcheck="true" value="${v('target_titles')}"><span class="warn" id="w_target_titles"></span></label>
<label>Seniority<select name="seniority">${sel('seniority', [['', 'Not asked yet'], ['entry', 'Entry'], ['mid', 'Mid'], ['senior', 'Senior'], ['lead', 'Lead / manager'], ['director', 'Director+']])}</select></label>
<label>Industries<input name="industries" value="${v('industries')}"></label>
<label>Locations <span>cities or regions to search, comma separated</span><input name="locations" value="${v('locations')}"></label>
<label>Work style<select name="remote">${sel('remote', [['any', 'Any'], ['remote', 'Remote only'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']])}</select></label>
<label>Salary minimum<input name="salary_min" inputmode="numeric" value="${v('salary_min')}"></label>
<label>Currency<input name="currency" value="${v('currency') || 'CAD'}"></label>
<label class="full">Salary answer for forms <span>exactly what to type when a form asks</span><input name="salary_answer" value="${v('salary_answer')}"></label>
<label>Preferred employers <span>company names, e.g. Shopify, RBC (not industries)</span><input name="preferred_employers" value="${v('preferred_employers')}"></label>
<label>Employers to avoid <span>company names</span><input name="excluded_employers" value="${v('excluded_employers')}"></label>
<label>Words that rule a job out <span>e.g. intern, commission</span><input name="excluded_keywords" value="${v('excluded_keywords')}"></label>
<label>Max job age (days)<input name="max_age_days" inputmode="numeric" value="${v('max_age_days') || 14}"></label>
</div>
<h2>Standard answers</h2><div class="grid">
<label>Legally allowed to work in target country?<select name="work_authorized">${yn('work_authorized')}</select></label>
<label>Needs visa sponsorship?<select name="needs_sponsorship">${yn('needs_sponsorship', 'no')}</select></label>
<label>Willing to relocate?<select name="willing_to_relocate">${yn('willing_to_relocate', 'no')}</select></label>
<label>Availability / notice period<input name="availability" value="${v('availability')}"></label>
<label class="full">Career gaps or anything recruiters should know<textarea name="considerations">${v('considerations')}</textarea></label>
<label>Client time zone<select name="timezone">${tzOpts}</select>${was('timezone', tz)}</label>
</div>
<h2>Master CV</h2>
<label>Upload the client's current CV <span>${cvNote}</span><input type="file" name="cv" accept=".docx,.pdf"><span class="err" id="w_cv"></span></label>
<h2>Consent</h2>
<p class="m">Tick only what the client has agreed to. LinkedIn sittings need the first box, Resume Worded scoring the second.</p>
<div class="consent">
<label class="check"><input type="checkbox" name="consent_linkedin"${ticked('linkedin_session')}> The client will sign in to LinkedIn themselves, on this computer, during sittings when they are present (in person or by screen share). During a sitting ApplyDesk searches LinkedIn jobs for them and opens Easy Apply jobs for them to submit. ApplyDesk never sees their password and never opens their LinkedIn when they are not present. They understand LinkedIn's User Agreement restricts automated tools, that LinkedIn may restrict their account, and that they can end it at any time with LinkedIn's "Sign out of all sessions".</label>
<label class="check"><input type="checkbox" name="consent_cv_upload"${ticked('cv_upload')}> The client agrees their CV may be uploaded to Resume Worded for quality checks.</label>
<label class="check"><input type="checkbox" name="consent_inbox"${ticked('inbox')}> The client authorises reading their job-search inbox for employer replies and verification codes.</label>
<label class="check"><input type="checkbox" name="consent_privacy_notices"${ticked('privacy_notices')}> The client authorises ticking employers' privacy-notice boxes on their behalf. (Legal attestations are always ticked by a person.)</label>
<label>Consent recorded by (operator name) <span>needed if any box is ticked</span><input name="consent_by" value="${esc(c.consent?.recorded_by)}"></label>
</div>
<button type="submit">Save client</button><div id="msg" role="status"></div>
</form></main>
<script>
const WORDS = ${JSON.stringify(TITLE_WORDS)};
${lev.toString()}
${titleWarnings.toString()}
const f = document.getElementById('f'), bar = document.getElementById('bar'), msg = document.getElementById('msg');
let expires = ${JSON.stringify(expiresAt || null)}, cvOk = true, timer;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function tick() {
  if (!expires) return;
  const left = Date.parse(expires) - Date.now();
  bar.className = left < 10 * 60e3 ? 'late' : '';
  bar.textContent = left <= 0 ? 'This form has closed. Your draft is saved: ask the agent to open the form again.'
    : 'Draft saved as you type. This form stays open until ' + hhmm(expires) + (left < 10 * 60e3 ? ' (type anything to keep it open).' : ' and longer while you use it.');
}
setInterval(tick, 15000); tick();
function fields() { const o = {}; for (const [k, v] of new FormData(f)) if (typeof v === 'string') o[k] = v; return o; }
async function saveDraft() {
  try {
    const r = await fetch('/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields()) });
    const j = await r.json(); if (j.expires_at) { expires = j.expires_at; tick(); }
  } catch { bar.textContent = 'This form has closed. Your last draft is saved: ask the agent to open the form again.'; bar.className = 'late'; }
}
function hints() {
  const city = f.city.value;
  document.getElementById('w_city').textContent = /\\d/.test(city) || city.split(',').length > 2 ? 'This looks like a street address: put the street above and only the city here.' : '';
  document.getElementById('w_target_titles').textContent = titleWarnings(f.target_titles.value.split(','), WORDS).join(' ');
  const li = f.linkedin_url.value.trim();
  document.getElementById('w_linkedin_url').textContent = li && !/linkedin\\.com\\/in\\/[^/]+/i.test(li) ? 'Use the profile address, like linkedin.com/in/jane-doe' : '';
}
f.addEventListener('input', () => { hints(); clearTimeout(timer); timer = setTimeout(saveDraft, 1500); });
f.addEventListener('change', () => { hints(); clearTimeout(timer); timer = setTimeout(saveDraft, 500); });
hints();
f.cv.addEventListener('change', async () => {
  const file = f.cv.files[0], out = document.getElementById('w_cv'); cvOk = true; out.textContent = '';
  if (!file) return;
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const s = String.fromCharCode(...b);
  if (b[0] === 0x50 && b[1] === 0x4b) return;
  if (s.startsWith('%PDF')) return;
  cvOk = false;
  out.textContent = b[0] === 0xd0 && b[1] === 0xcf ? ${JSON.stringify(CV_PROBLEMS.doc)} : s.startsWith('{\\\\rtf') ? ${JSON.stringify(CV_PROBLEMS.rtf)} : ${JSON.stringify(CV_PROBLEMS.unknown)};
});
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cvOk) { msg.textContent = 'Not saved: fix the CV file first (see the message under it).'; return; }
  msg.textContent = 'Saving…';
  try {
    const res = await fetch('/save', { method: 'POST', body: new FormData(f) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { msg.textContent = 'Saved.' + (j.warnings?.length ? '\\n' + j.warnings.join('\\n') : '') + '\\nYou can close this tab and go back to the agent.'; expires = null; bar.textContent = 'Saved.'; }
    else msg.textContent = 'Not saved:\\n' + (j.errors ? Object.values(j.errors).join('\\n') : (j.error || res.status));
  } catch { msg.textContent = 'Not saved: the form has closed. Your draft is kept; ask the agent to open the form again.'; }
});
</script></body></html>`;
}

// ---------- the server ----------

const draftFile = (key) => paths.state('drafts', `${slug(key || 'new')}.json`);
export const formStateFile = () => paths.state('onboard-form.json');

// Serve the form until it is saved. It closes after `idleMin` minutes without
// any typing (each draft save pushes that back), and never later than `maxHours`.
export function runOnboarding(existingId, { idleMin = 60, maxHours = 8, onUrl, onExpire } = {}) {
  const token = randomBytes(16).toString('hex');
  const existing = existingId ? readJson(paths.clientFile(existingId), {}) : {};
  const key = existingId || 'new';
  const started = Date.now();
  let expiresAt = started + idleMin * 60e3;
  const bump = () => (expiresAt = Math.min(started + maxHours * 3600e3, Math.max(expiresAt, Date.now() + idleMin * 60e3)));
  return new Promise((resolve, reject) => {
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('t') === token) {
        const draft = readJson(draftFile(key), null);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(formPage(token, prefill(existing, draft), { expiresAt: new Date(expiresAt).toISOString(), warnings: draft ? ['Your unsaved draft from earlier is filled back in.'] : [] }));
      }
      // Same-origin page only: the token travels in the body, never in a cookie.
      if (req.method === 'POST' && url.pathname === '/draft') {
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const draft = JSON.parse(body);
          if (draft.token !== token) return json(res, 403, { error: 'bad token' });
          delete draft.token;
          writeJson(draftFile(key), draft);
          bump();
          return json(res, 200, { expires_at: new Date(expiresAt).toISOString() });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/save') {
        try {
          const fd = await new Request('http://x', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
          if (fd.get('token') !== token) throw new FormError({ token: 'This form has expired. Ask the agent to open it again.' });
          const form = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string'));
          if (existingId) form.id = existingId; // the ID of a saved client never changes
          const warnings = [];
          const client = toClient(form, existing, warnings);
          const dir = ensureDir(paths.client(client.id));
          const cv = fd.get('cv');
          if (cv && typeof cv !== 'string' && cv.size > 0) client.master_cv = await saveMasterCv(dir, Buffer.from(await cv.arrayBuffer()), cv.name);
          writeJson(paths.clientFile(client.id), client);
          rmSync(draftFile(key), { force: true });
          json(res, 200, { ok: true, warnings });
          server.close();
          resolve({ client, warnings });
        } catch (e) {
          json(res, 400, e instanceof FormError ? { errors: e.errors } : { error: e.message });
        }
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      if (onUrl) onUrl(url, () => new Date(expiresAt).toISOString());
    });
    const check = setInterval(() => {
      if (Date.now() < expiresAt) return;
      clearInterval(check);
      server.close();
      if (onExpire) onExpire();
      reject(new Error('The onboarding form closed after an hour without typing. The draft is saved: open the form again to finish it.'));
    }, 5000);
    check.unref?.();
    server.on('close', () => clearInterval(check));
  });
}

// ---------- the background process ----------

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Start `client serve` in the background and wait for its address.
export async function startFormProcess(existingId) {
  const prev = readJson(formStateFile(), null);
  if (prev?.pid && prev.status === 'open' && pidAlive(prev.pid)) {
    if ((prev.client || null) === (existingId || null)) return { ...prev, reused: true };
    try {
      process.kill(prev.pid); // its draft is already saved
    } catch {}
  }
  writeJson(formStateFile(), { status: 'starting', client: existingId || null });
  const args = [join(SCRIPTS_DIR, 'applydesk.mjs'), 'client', 'serve', ...(existingId ? [existingId] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const st = readJson(formStateFile(), null);
    if (st?.pid === child.pid && st.url) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The onboarding form did not start. Run the command again; if it keeps failing, run: applydesk doctor');
}

// The body of `client serve`: runs in the background process.
export async function serveForm(existingId) {
  const write = (patch) => writeJson(formStateFile(), { ...(readJson(formStateFile(), {}) || {}), ...patch });
  try {
    const { client, warnings } = await runOnboarding(existingId, {
      onUrl: (url, expires) => {
        write({ status: 'open', url, pid: process.pid, client: existingId || null, started_at: new Date().toISOString(), expires_at: expires() });
        // Keep the shown closing time current as drafts push it back.
        setInterval(() => existsSync(formStateFile()) && write({ expires_at: expires() }), 30000).unref();
      },
    });
    write({ status: 'saved', saved_client: client.id, saved_at: new Date().toISOString(), missing: missingInfo(client), warnings, url: null });
  } catch (e) {
    write({ status: 'closed', reason: e.message, url: null });
  }
  process.exit(0);
}

// Open the form where the operator will see it. Returns how it was opened.
export async function openForm(url, { toolsProfile } = {}) {
  if (process.env.APPLYDESK_NO_OPEN === '1') return 'not opened (APPLYDESK_NO_OPEN)';
  if (toolsProfile) {
    try {
      const { withProfile } = await import('./browser.mjs');
      await withProfile(toolsProfile, async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.bringToFront();
      });
      return 'ApplyDesk browser window';
    } catch {}
  }
  // rundll32 takes the address as one plain argument: no shell quoting to go wrong.
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'default browser';
  } catch {
    return 'not opened';
  }
}

