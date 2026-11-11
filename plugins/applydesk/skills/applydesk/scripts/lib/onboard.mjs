// Client onboarding form: a one-page web form served on 127.0.0.1 with a
// one-time token. The operator fills in what they know (only the ID and name are
// required), clicks Save, and the server writes client.json + the master CV, then
// exits. The rest is added later with `client edit`.
// No passwords are collected: the client signs in to LinkedIn themselves, in a sitting.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, paths, readJson, writeJson, slug } from './config.mjs';
import { docxToMarkdown } from './docs.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function formPage(token, c = {}) {
  const v = (k) => esc(Array.isArray(c[k]) ? c[k].join(', ') : c[k]);
  const sel = (k, opts) => opts.map(([val, label]) => `<option value="${val}" ${c[k] === val ? 'selected' : ''}>${label}</option>`).join('');
  // Yes/no answers are stored as true/false/null; null means nobody has asked yet.
  const yn = (k, first = 'yes') => {
    const cur = c[k] === true ? 'yes' : c[k] === false ? 'no' : '';
    const opts = [['', 'Not asked yet'], ...(first === 'yes' ? [['yes', 'Yes'], ['no', 'No']] : [['no', 'No'], ['yes', 'Yes']])];
    return opts.map(([val, label]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${label}</option>`).join('');
  };
  const ticked = (k) => (c.consent?.[k] ? ' checked' : '');
  const tz = esc(c.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ApplyDesk — client onboarding</title>
<style>
:root{--bg:#f6f7f6;--ink:#18201e;--muted:#56615d;--line:#d9dfdc;--accent:#0f6b5c;--warn:#8a4b08}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 80px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px;padding-top:14px;border-top:1px solid var(--line)}
p.m{color:var(--muted);margin:0 0 12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:600px){.grid{grid-template-columns:1fr}}
label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.92rem}label span{font-weight:400;color:var(--muted);font-size:.85rem}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:#fff}textarea{min-height:64px}
.full{grid-column:1/-1}.check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:400}.check input{margin-top:5px}
.consent{border:1px solid var(--warn);border-radius:8px;padding:12px 14px;background:#fbeedd;display:flex;flex-direction:column;gap:10px}
button{margin-top:24px;font:600 1rem system-ui;padding:12px 22px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
#msg{margin-top:14px;font-weight:600}
</style></head><body><main>
<h1>Client onboarding</h1><p class="m">Only the client ID and full name are required. Fill in what you have now and add the rest later (ask the agent to edit the client). It is saved on this computer only. Do not enter any passwords here.</p>
<form id="f" enctype="multipart/form-data">
<input type="hidden" name="token" value="${token}">
<h2>Who</h2><div class="grid">
<label>Client ID <span>short, no spaces, e.g. jane-doe</span><input name="id" required pattern="[a-z0-9-]{2,40}" value="${v('id')}"></label>
<label>Full name<input name="full_name" required value="${v('full_name')}"></label>
<label>Email used for applications<input type="email" name="email" value="${v('email')}"></label>
<label>Phone<input name="phone" value="${v('phone')}"></label>
<label>City<input name="city" value="${v('city')}"></label>
<label>Province / state<input name="region" value="${v('region')}"></label>
<label>Country<input name="country" value="${v('country')}"></label>
<label>Postal code<input name="postal_code" value="${v('postal_code')}"></label>
<label class="full">LinkedIn profile URL<input type="url" name="linkedin_url" placeholder="https://www.linkedin.com/in/..." value="${v('linkedin_url')}"></label>
<label>Website / portfolio<input name="website" value="${v('website')}"></label>
<label>Current employer<input name="current_company" value="${v('current_company')}"></label>
</div>
<h2>What they want</h2><div class="grid">
<label class="full">Target job titles <span>comma separated, most important first</span><input name="target_titles" value="${v('target_titles')}"></label>
<label>Seniority<select name="seniority">${sel('seniority', [['entry', 'Entry'], ['mid', 'Mid'], ['senior', 'Senior'], ['lead', 'Lead / manager'], ['director', 'Director+']])}</select></label>
<label>Industries<input name="industries" value="${v('industries')}"></label>
<label>Locations <span>comma separated</span><input name="locations" value="${v('locations')}"></label>
<label>Work style<select name="remote">${sel('remote', [['any', 'Any'], ['remote', 'Remote only'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']])}</select></label>
<label>Salary minimum<input name="salary_min" inputmode="numeric" value="${v('salary_min')}"></label>
<label>Currency<input name="currency" value="${v('currency') || 'CAD'}"></label>
<label class="full">Salary answer for forms <span>exactly what to type when a form asks</span><input name="salary_answer" value="${v('salary_answer')}"></label>
<label>Preferred employers<input name="preferred_employers" value="${v('preferred_employers')}"></label>
<label>Employers to avoid<input name="excluded_employers" value="${v('excluded_employers')}"></label>
<label>Words that rule a job out <span>e.g. intern, commission</span><input name="excluded_keywords" value="${v('excluded_keywords')}"></label>
<label>Max job age (days)<input name="max_age_days" inputmode="numeric" value="${v('max_age_days') || 14}"></label>
</div>
<h2>Standard answers</h2><div class="grid">
<label>Legally allowed to work in target country?<select name="work_authorized">${yn('work_authorized')}</select></label>
<label>Needs visa sponsorship?<select name="needs_sponsorship">${yn('needs_sponsorship', 'no')}</select></label>
<label>Willing to relocate?<select name="willing_to_relocate">${yn('willing_to_relocate', 'no')}</select></label>
<label>Availability / notice period<input name="availability" value="${v('availability')}"></label>
<label class="full">Career gaps or anything recruiters should know<textarea name="considerations">${v('considerations')}</textarea></label>
<label>Client time zone<input name="timezone" value="${tz}"></label>
</div>
<h2>Master CV</h2>
<label>Upload the client's current CV (.docx) <span>${c.master_cv ? 'one is saved; upload only to replace it' : 'needed before CVs can be tailored'}</span><input type="file" name="cv" accept=".docx"></label>
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
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg'); msg.textContent = 'Saving…';
  const res = await fetch('/save', { method: 'POST', body: new FormData(e.target) });
  const j = await res.json().catch(() => ({}));
  msg.textContent = res.ok ? 'Saved. You can close this tab and go back to the agent.' : ('Not saved: ' + (j.error || res.status));
});
</script></body></html>`;
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const text = (s) => String(s ?? '').trim() || null;
const yesNo = (s) => (s === 'yes' ? true : s === 'no' ? false : null);

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

export function toClient(form, existing = {}) {
  const id = slug(form.id || '');
  const full_name = text(form.full_name);
  if (!id || !full_name) throw new Error('The client ID and full name are required');
  const [first, ...rest] = full_name.split(/\s+/);
  const consent = {
    linkedin_session: Boolean(form.consent_linkedin),
    cv_upload: Boolean(form.consent_cv_upload),
    inbox: Boolean(form.consent_inbox),
    privacy_notices: Boolean(form.consent_privacy_notices),
  };
  const anyConsent = Object.values(consent).some(Boolean);
  const recorded_by = text(form.consent_by);
  if (anyConsent && !recorded_by) throw new Error('Enter the operator name under "Consent recorded by"');
  const prev = existing.consent || {};
  const same = Object.keys(consent).every((k) => Boolean(prev[k]) === consent[k]) && prev.recorded_by === recorded_by;
  return {
    ...existing,
    id,
    full_name,
    first_name: first,
    last_name: rest.join(' '),
    email: text(form.email),
    phone: text(form.phone),
    city: text(form.city), region: text(form.region), country: text(form.country), postal_code: text(form.postal_code),
    linkedin_url: text(form.linkedin_url),
    website: text(form.website),
    current_company: text(form.current_company),
    target_titles: list(form.target_titles),
    seniority: form.seniority || null,
    industries: list(form.industries),
    locations: list(form.locations),
    remote: form.remote || 'any',
    salary_min: form.salary_min ? Number(form.salary_min) : null,
    currency: text(form.currency),
    salary_answer: text(form.salary_answer),
    preferred_employers: list(form.preferred_employers),
    excluded_employers: list(form.excluded_employers),
    excluded_keywords: list(form.excluded_keywords),
    max_age_days: Number(form.max_age_days) || 14,
    work_authorized: yesNo(form.work_authorized),
    needs_sponsorship: yesNo(form.needs_sponsorship),
    willing_to_relocate: yesNo(form.willing_to_relocate),
    availability: text(form.availability),
    considerations: form.considerations || '',
    timezone: text(form.timezone),
    eeo_answers: existing.eeo_answers || { gender: 'decline', ethnicity: 'decline', veteran: 'decline', disability: 'decline' },
    consent: {
      ...consent,
      recorded_by,
      recorded_at: same && prev.recorded_at ? prev.recorded_at : anyConsent ? new Date().toISOString() : null,
    },
    created_at: existing.created_at || new Date().toISOString(),
  };
}

function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function runOnboarding(existingId, { open = true, timeoutMin = 60, onUrl } = {}) {
  const token = randomBytes(16).toString('hex');
  const existing = existingId ? readJson(paths.clientFile(existingId), {}) : {};
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('t') === token) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(formPage(token, existing));
      }
      if (req.method === 'POST' && url.pathname === '/save') {
        try {
          const fd = await new Request('http://x', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
          if (fd.get('token') !== token) throw new Error('bad token');
          const form = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string'));
          const client = toClient(form, existing);
          const dir = ensureDir(paths.client(client.id));
          const cv = fd.get('cv');
          if (cv && typeof cv !== 'string' && cv.size > 0) {
            const cvDir = ensureDir(join(dir, 'cv'));
            const docx = join(cvDir, 'master.docx');
            writeFileSync(docx, Buffer.from(await cv.arrayBuffer()));
            writeFileSync(join(cvDir, 'master.md'), await docxToMarkdown(docx));
            client.master_cv = { docx, md: join(cvDir, 'master.md'), uploaded_at: new Date().toISOString() };
          }
          writeJson(paths.clientFile(client.id), client);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          server.close();
          resolve(client);
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      process.stderr.write(`Onboarding form: ${url}\n`);
      if (onUrl) onUrl(url);
      if (open) openUrl(url);
    });
    setTimeout(() => {
      server.close();
      reject(new Error('Onboarding form timed out without being saved'));
    }, timeoutMin * 60e3).unref();
  });
}
