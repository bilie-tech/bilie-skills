// End-to-end: drives the real CLI and a real (headless) Chrome or Edge against a
// local practice job site. Runs only with APPLYDESK_E2E=1 because it needs a
// browser and the runtime packages (installed by `doctor --fix` if missing).
//
// Covers: doctor, operator setup, onboarding form (real HTTP + multipart CV
// upload), sitting rules, CV check/render, employer-site fill, the refusal to
// click Submit or tick declarations, a person submitting, apply done + CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const run = process.env.APPLYDESK_E2E === '1';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'plugins/applydesk/skills/applydesk/scripts/applydesk.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'applydesk-e2e-'));
const env = { ...process.env, APPLYDESK_HOME: HOME, APPLYDESK_HEADLESS: '1', APPLYDESK_ALLOW_UNENCRYPTED: '1' };
process.env.APPLYDESK_HOME = HOME;
if (env.APPLYDESK_RUNTIME) process.env.APPLYDESK_RUNTIME = env.APPLYDESK_RUNTIME;

// Async on purpose: the practice site is served from this same process.
async function cli(...args) {
  const r = await promisify(execFile)(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 240000 }).catch((e) => e);
  const line = (r.stdout || '').trim().split(/\r?\n/).pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`No JSON from "${args.join(' ')}": ${r.stdout}\n${r.stderr}`);
  }
}

// Practice employer site: one job form with the usual parts.
const FORM = `<!doctype html><html><head><title>Data Analyst - Acme</title></head><body><main>
<h1>Apply: Data Analyst</h1>
<form action="/done" method="get">
<label>First name <input name="first" required></label>
<label>Last name <input name="last" required></label>
<label>Email <input type="email" name="email" required></label>
<label>Phone <input name="phone" required></label>
<label>Resume/CV <input type="file" name="cv" required></label>
<label for="sp">Will you require visa sponsorship?</label>
<select id="sp" name="sp" required><option value="">Select</option><option>Yes</option><option>No</option></select>
<label>Why do you want to work at Acme? <textarea name="why" required></textarea></label>
<label><input type="checkbox" name="cert" required> I certify that the information provided is true and complete</label>
<button type="submit">Submit application</button>
</form></main></body></html>`;
const DONE = '<!doctype html><html><body><main><h1>Thank you</h1><p>Your application has been received.</p></main></body></html>';

test('end to end on a practice job site', { skip: !run && 'set APPLYDESK_E2E=1 to run', timeout: 600000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/done') ? DONE : FORM);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. doctor installs packages (or finds them) and finds a browser
    const doc = (await cli('doctor', '--fix'));
    const failed = (doc.failed || []).map((c) => c.name);
    for (const must of ['node', 'packages', 'browser']) assert.ok(!failed.includes(must), `doctor: ${must} failed: ${JSON.stringify(doc)}`);
    assert.equal(doc.linkedin_allowed, true, JSON.stringify(doc));

    assert.equal((await cli('setup', '--operator', 'Tester')).status, 'ok');

    // 2. onboarding form over real HTTP with a .docx upload
    const { markdownToDocx } = await import('../plugins/applydesk/skills/applydesk/scripts/lib/docs.mjs');
    const masterMd = join(HOME, 'master-src.md');
    writeFileSync(masterMd, '# Jane Doe\nToronto, ON · +1 416 555 0100 · jane@example.com\n\n## Summary\nData analyst with 5 years in retail analytics.\n\n## Skills\nSQL, Excel, Python, Power BI\n\n## Experience\n### Data Analyst — Northwind\nJan 2021 – Present · Toronto\n- Built 14 SQL dashboards in Power BI used by 6 regional teams\n- Cut weekly reporting time 40% by automating Excel models with Python\n- Led a 3-person team migrating 120 reports from Excel to Power BI in 4 months\n- Trained 25 store managers to read sales dashboards, lifting adoption to 90%\n\n### Junior Analyst — Contoso\nJun 2019 – Dec 2020 · Toronto\n- Cleaned 2M-row sales dataset, raising forecast accuracy 12%\n- Wrote 30 SQL queries that fed the monthly board pack\n\n## Education\n### BSc Statistics — University of Toronto\n2019\n');
    const masterDocx = join(HOME, 'master-src.docx');
    await markdownToDocx(masterMd, masterDocx);
    const { runOnboarding } = await import('../plugins/applydesk/skills/applydesk/scripts/lib/onboard.mjs');
    let formUrl;
    const saved = runOnboarding(null, { open: false, onUrl: (u) => (formUrl = u) });
    while (!formUrl) await new Promise((r) => setTimeout(r, 50));
    const html = await (await fetch(formUrl)).text();
    const token = html.match(/name="token" value="([0-9a-f]+)"/)[1];
    const fd = new FormData();
    const fields = { token, id: 'jane-doe', full_name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100', city: 'Toronto', region: 'ON', country: 'Canada', linkedin_url: 'https://www.linkedin.com/in/janedoe', target_titles: 'Data Analyst', seniority: 'mid', remote: 'hybrid', work_authorized: 'yes', needs_sponsorship: 'no', willing_to_relocate: 'no', availability: '2 weeks', timezone: 'America/Toronto', consent_linkedin: 'on', consent_cv_upload: 'on', consent_by: 'tester' };
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set('cv', new Blob([readFileSync(masterDocx)]), 'master.docx');
    assert.equal((await fetch(new URL('/save', formUrl), { method: 'POST', body: fd })).status, 200);
    const client = await saved;
    assert.equal(client.id, 'jane-doe');
    assert.match(readFileSync(client.master_cv.md, 'utf8'), /Northwind/);

    // 3. LinkedIn is closed without a sitting, and sittings need the client present
    assert.equal((await cli('discover', 'linkedin', 'jane-doe')).status, 'blocked');
    assert.equal((await cli('easy', 'next', 'jane-doe')).status, 'blocked');
    assert.equal((await cli('sitting', 'start', 'jane-doe')).status, 'blocked');
    assert.equal((await cli('page', 'goto', 'jane-doe', 'https://www.linkedin.com/jobs/')).status, 'fail');

    // 4. an employer-site job, tailored CV, check, render
    const { addJob } = await import('../plugins/applydesk/skills/applydesk/scripts/lib/jobs.mjs');
    const jd = 'Acme is hiring a Data Analyst. You will use SQL, Power BI and Python to build dashboards and automate reporting for regional teams. Excel skills required. '.repeat(3);
    const { jobId } = addJob('jane-doe', { source: 'link', external_id: `${site}/job`, url: `${site}/job`, apply_url: `${site}/apply`, title: 'Data Analyst', company: 'Acme', description: jd });
    const brief = (await cli('cv', 'brief', 'jane-doe', jobId));
    assert.equal(brief.status, 'ok');
    writeFileSync(brief.write_to, readFileSync(masterMd, 'utf8').replace('Data analyst with 5 years in retail analytics.', 'Data analyst with 5 years building SQL and Power BI dashboards and automating reporting with Python.'));
    const check = (await cli('cv', 'check', 'jane-doe', jobId));
    assert.ok(['ok', 'fail'].includes(check.status), JSON.stringify(check));
    assert.equal((check.issues || []).filter((i) => i.rule === 'trace').length, 0, JSON.stringify(check.issues)); // nothing invented
    const render = (await cli('cv', 'render', 'jane-doe', jobId));
    assert.equal(render.status, 'ok');
    assert.ok(existsSync(render.docx));

    // 5. fill the employer form
    const start = (await cli('apply', 'start', 'jane-doe', jobId));
    assert.equal(start.status, 'ok', JSON.stringify(start));
    assert.ok(start.filled >= 6, JSON.stringify(start));
    const leftLabels = start.left.map((f) => f.label).join(' | ');
    assert.match(leftLabels, /Why do you want/);
    assert.match(leftLabels, /certify/);
    const why = start.left.find((f) => /Why do you want/.test(f.label));
    const setWhy = await cli('page', 'set', 'jane-doe', why.id, 'Acme builds the reporting tools I have spent five years building.');
    assert.equal(setWhy.status, 'ok', JSON.stringify(setWhy));

    // 6. the agent may not tick the declaration or click Submit
    const cert = start.left.find((f) => /certify/.test(f.label));
    assert.equal((await cli('page', 'set', 'jane-doe', cert.id, 'checked')).status, 'blocked');
    assert.equal((await cli('page', 'click', 'jane-doe', '--text', 'Submit application')).status, 'blocked');
    assert.equal((await cli('apply', 'ready', 'jane-doe', jobId)).status, 'fail'); // declaration still unticked

    // 7. a person ticks and submits (simulated here over the same browser)
    const { withProfile, pickPage } = await import('../plugins/applydesk/skills/applydesk/scripts/lib/browser.mjs');
    await withProfile('apply-jane-doe', async (ctx) => {
      const page = await pickPage(ctx, '127.0.0.1');
      await page.check('input[name=cert]');
    });
    const ready = (await cli('apply', 'ready', 'jane-doe', jobId));
    assert.equal(ready.status, 'ok', JSON.stringify(ready));
    assert.ok(existsSync(ready.evidence));
    assert.equal((await cli('queue')).submit_now.length, 1);
    await withProfile('apply-jane-doe', async (ctx) => {
      const page = await pickPage(ctx, '127.0.0.1');
      await Promise.all([page.waitForURL(/\/done/), page.click('button[type=submit]')]);
    });

    // 8. log it
    const done = (await cli('apply', 'done', 'jane-doe', jobId));
    assert.equal(done.status, 'ok', JSON.stringify(done));
    assert.equal(done.confirmation_seen, true);
    const csv = readFileSync(done.csv, 'utf8');
    assert.match(csv, /Acme/);
    assert.match(csv, /Employer site/);
  } finally {
    (await cli('browser', 'close', 'jane-doe'));
    server.close();
  }
});

// LinkedIn pages are never loaded in tests. Saved copies shaped like the 2026
// layouts are read in a real browser with the same in-page functions the CLI uses.
test('LinkedIn page reader and sign-in check on saved pages (real browser)', { skip: !run }, async () => {
  const S = '../plugins/applydesk/skills/applydesk/scripts/lib';
  const { jobSignalsInPage, parseJob } = await import(`${S}/lijob.mjs`);
  const LI = await import(`${S}/linkedin.mjs`);
  const { withProfile } = await import(`${S}/browser.mjs`);
  const fixture = (n) => readFileSync(join(ROOT, 'tests/fixtures', n), 'utf8');
  await withProfile('fixture-reader', async (ctx) => {
    const page = await ctx.newPage();
    await page.setContent(fixture('linkedin-job-signed-in.html'));
    const j = parseJob(await page.evaluate(jobSignalsInPage), '4100000001', await page.content());
    assert.equal(j.title, 'Senior Data Analyst');
    assert.equal(j.company, 'Northwind Traders');
    assert.equal(j.location, 'Toronto, ON');
    assert.match(j.description, /^Northwind Traders is hiring a Senior Data Analyst/);
    assert.match(j.description, /5\+ years in analytics/);
    assert.doesNotMatch(j.description, /specialty foods|Contoso/);
    assert.equal(j.route, 'employer_site');
    assert.equal(j.complete, true);
    assert.equal(LI.signedInFrom(await page.evaluate(LI.signInSignalsInPage)), true);

    await page.setContent(fixture('linkedin-job-guest.html'));
    const g = parseJob(await page.evaluate(jobSignalsInPage), '7', await page.content());
    assert.equal(g.title, 'Data Analyst');
    assert.equal(g.company, 'Acme');
    assert.match(g.description, /Tableau/);
    assert.equal(g.route, 'easy_apply');
    assert.equal(LI.signedInFrom(await page.evaluate(LI.signInSignalsInPage)), false); // public page
    await page.close();
  });
  const { closeProfile } = await import(`${S}/browser.mjs`);
  await closeProfile('fixture-reader');
});
