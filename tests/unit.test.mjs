// Unit tests: pure logic, no browser and no third-party packages.
// Each test file gets its own throwaway APPLYDESK_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APPLYDESK_HOME = mkdtempSync(join(tmpdir(), 'applydesk-unit-'));

const L = '../plugins/applydesk/skills/applydesk/scripts/lib';
const LI = await import(`${L}/linkedin.mjs`);
const { checkCv } = await import(`${L}/cvcheck.mjs`);
const { planFill, answerSheet, SUBMIT_TEXT } = await import(`${L}/form.mjs`);
const { addJob, getJob, listJobs, mergeFetched, routeOf } = await import(`${L}/jobs.mjs`);
const { parseJob, parseJobTitle, applyRoute, htmlToText } = await import(`${L}/lijob.mjs`);
const { pactenRecord, appendCsv } = await import(`${L}/tracker.mjs`);
const { toClient, formPage, missingInfo } = await import(`${L}/onboard.mjs`);
const { findBrowser } = await import(`${L}/browser.mjs`);
const { slug, linkedinProfileName, applyProfileName } = await import(`${L}/config.mjs`);
const { verdict } = await import('../plugins/applydesk/hooks/guard.mjs');
const { detectAts } = await import(`${L}/ats.mjs`);
const { parseScore } = await import(`${L}/rw.mjs`);

const client = toClient({
  id: 'jane-doe', full_name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100', city: 'Toronto', region: 'ON', country: 'Canada',
  linkedin_url: 'https://www.linkedin.com/in/janedoe', target_titles: 'Data Analyst, BI Analyst', remote: 'hybrid', work_authorized: 'yes',
  needs_sponsorship: 'no', willing_to_relocate: 'no', salary_answer: '85000', consent_linkedin: 'on', consent_cv_upload: 'on', consent_by: 'op',
});

test('onboarding builds a client with no working-hours or caps fields', () => {
  assert.equal(client.id, 'jane-doe');
  assert.deepEqual(client.target_titles, ['Data Analyst', 'BI Analyst']);
  assert.equal(client.consent.linkedin_session, true);
  assert.equal(client.working_hours, undefined);
  assert.equal(client.linkedin, undefined);
});

test('onboarding: only the client ID and name are required', () => {
  const html = formPage('tok');
  const required = [...html.matchAll(/<(input|select|textarea)[^>]*\brequired\b[^>]*>/g)].map((m) => m[0].match(/name="([^"]+)"/)[1]);
  assert.deepEqual(required.sort(), ['full_name', 'id']);
  const c = toClient({ id: 'sam', full_name: 'Sam Lee' });
  assert.equal(c.id, 'sam');
  assert.equal(c.first_name, 'Sam');
  assert.equal(c.email, null);
  assert.deepEqual(c.target_titles, []);
  // Yes/no answers nobody asked about stay unknown, never a guessed Yes/No.
  assert.equal(c.work_authorized, null);
  assert.equal(c.needs_sponsorship, null);
  assert.equal(c.consent.linkedin_session, false);
  const missing = missingInfo(c);
  for (const k of ['email', 'phone', 'linkedin_url', 'target_titles', 'master_cv', 'consent_linkedin']) assert.ok(missing.includes(k), k);
  assert.deepEqual(missingInfo(client).filter((k) => k !== 'master_cv'), []);
});

test('onboarding: a ticked consent needs the operator name', () => {
  assert.throws(() => toClient({ id: 'sam', full_name: 'Sam Lee', consent_linkedin: 'on' }), /operator/i);
});

test('onboarding: editing keeps consents and fills in the gaps', () => {
  const first = toClient({ id: 'sam', full_name: 'Sam Lee', consent_linkedin: 'on', consent_by: 'op' });
  const html = formPage('tok', first);
  assert.match(html, /name="consent_linkedin" checked/);
  const later = toClient({ id: 'sam', full_name: 'Sam Lee', email: 'sam@example.com', consent_linkedin: 'on', consent_by: 'op' }, first);
  assert.equal(later.email, 'sam@example.com');
  assert.equal(later.consent.linkedin_session, true);
  assert.equal(later.consent.recorded_at, first.consent.recorded_at);
  assert.equal(later.created_at, first.created_at);
});

test('each client gets separate LinkedIn and apply profiles', () => {
  assert.equal(linkedinProfileName('Jane Doe'), 'li-jane-doe');
  assert.equal(applyProfileName('Jane Doe'), 'apply-jane-doe');
  assert.equal(slug('Ébène  Okafor!'), 'ebene-okafor');
});

test('LinkedIn: job pages allowed, people/messaging/profiles never', () => {
  assert.ok(LI.allowed('https://www.linkedin.com/jobs/view/1234567/'));
  assert.ok(LI.allowed(LI.searchUrl({ keywords: 'analyst', location: 'Toronto' })));
  assert.ok(!LI.allowed('https://www.linkedin.com/messaging/thread/1'));
  assert.ok(!LI.allowed('https://www.linkedin.com/in/janedoe/'));
  assert.ok(!LI.allowed('https://www.linkedin.com/search/results/people/?keywords=x'));
});

test('LinkedIn: security checks are recognised', () => {
  assert.ok(LI.isCheckpoint('https://www.linkedin.com/checkpoint/challenge/x'));
  assert.ok(LI.isCheckpoint('https://www.linkedin.com/jobs/', "Let's do a quick security check"));
  assert.ok(!LI.isCheckpoint('https://www.linkedin.com/jobs/', 'Data Analyst at Acme'));
});

test('LinkedIn: search URL pages and filters', () => {
  const u = new URL(LI.searchUrl({ keywords: 'Data Analyst', location: 'Toronto', remote: 'remote', days: 7, start: 25 }));
  assert.equal(u.searchParams.get('f_WT'), '2');
  assert.equal(u.searchParams.get('f_TPR'), 'r604800');
  assert.equal(u.searchParams.get('start'), '25');
  assert.deepEqual(LI.jobIdsFromHtml('<a href="/jobs/view/3999111222/">x</a> data-job-id="3999111333"'), ['3999111222', '3999111333']);
  assert.equal(LI.ageDays('Reposted 2 weeks ago'), 14);
});

test('sittings: one client at a time, required for LinkedIn work, expire', () => {
  assert.match(LI.sittingProblem('jane-doe'), /No sitting open/);
  const r = LI.startSitting('jane-doe', { operator: 'op', present: 'Jane Doe' });
  assert.equal(r.resumed, false);
  LI.markSignedIn('jane-doe');
  assert.equal(LI.sittingProblem('jane-doe'), null);
  assert.match(LI.sittingProblem('bob'), /open sitting is for jane-doe/);
  assert.match(LI.startSitting('bob', { operator: 'op' }).error, /still open/);
  assert.equal(LI.startSitting('jane-doe', { operator: 'op' }).resumed, true);
  // three hours later it has ended on its own
  assert.equal(LI.activeSitting(Date.now() + (LI.SITTING_HOURS * 3600e3 + 1000)), null);
  assert.match(LI.sittingProblem('jane-doe'), /No sitting open/);
  const log = readFileSync(join(process.env.APPLYDESK_HOME, 'logs', 'sittings.jsonl'), 'utf8');
  assert.match(log, /"event":"start"/);
  assert.match(log, /"reason":"expired"/);
});

test('a security check ends the sitting and leaves a hold', () => {
  LI.startSitting('jane-doe', { operator: 'op' });
  LI.stopForCheck('jane-doe', 'https://www.linkedin.com/checkpoint/x');
  assert.equal(LI.activeSitting(), null);
  assert.ok(LI.lastHold('jane-doe'));
  LI.clearHold('jane-doe');
  assert.equal(LI.lastHold('jane-doe'), null);
});

test('jobs keep their route (Easy Apply vs employer site)', () => {
  const a = addJob('jane-doe', { source: 'linkedin', external_id: '111', title: 'Data Analyst', company: 'Acme', url: LI.viewUrl('111'), easy_apply: true, description: 'x'.repeat(300) });
  const b = addJob('jane-doe', { source: 'linkedin', external_id: '222', title: 'BI Analyst', company: 'Beta', url: LI.viewUrl('222'), apply_url: 'https://boards.greenhouse.io/beta/jobs/9', description: 'y'.repeat(300) });
  assert.equal(getJob('jane-doe', a.jobId).easy_apply, true);
  assert.equal(getJob('jane-doe', b.jobId).easy_apply, false);
  assert.equal(getJob('jane-doe', b.jobId).ats, 'greenhouse');
  assert.equal(addJob('jane-doe', { source: 'linkedin', external_id: '111' }).created, false); // dedup
  assert.equal(listJobs('jane-doe').length, 2);
});

test('Pacten record says how it was applied; CSV has a BOM for Excel', () => {
  const m = listJobs('jane-doe').find((j) => j.easy_apply);
  const rec = pactenRecord({ ...m, status: 'applied' }, client, { jdPath: 'jd.md' });
  assert.equal(rec['Applied via'], 'LinkedIn Easy Apply (client)');
  const file = appendCsv(rec);
  assert.equal(readFileSync(file, 'utf8').charCodeAt(0), 0xfeff);
});

test('CV check: invented skills are caught (trace rule)', () => {
  const master = '# Jane Doe\nToronto · 555 · jane@example.com\n## Experience\n### Analyst — Acme\n- Built SQL reports for 12 teams, cutting prep time 30%\n## Education\n### BSc — UofT\n## Skills\nSQL, Excel';
  const jd = 'We need SQL, Excel and Tableau and Snowflake experience. Tableau dashboards. Snowflake warehouse.';
  const honest = checkCv({ tailored: master, master, jd });
  const invented = checkCv({ tailored: master + ', Tableau, Snowflake', master, jd });
  assert.equal(honest.issues.some((i) => /trace|invent|not in the master/i.test(JSON.stringify(i))), false);
  assert.ok(invented.issues.some((i) => i.severity === 'high'));
  assert.equal(invented.pass, false);
});

test('form planning: profile answers fill, declarations are left for a person', () => {
  const fields = [
    { id: 'f1', type: 'text', label: 'First name', required: true },
    { id: 'f2', type: 'email', label: 'Email', required: true },
    { id: 'f3', type: 'select-one', label: 'Will you require visa sponsorship?', required: true, options: ['Select', 'Yes', 'No'] },
    { id: 'f4', type: 'checkbox', label: 'I certify the information is true and complete', required: true },
    { id: 'f5', type: 'file', label: 'Resume/CV', required: true },
    { id: 'f6', type: 'text', label: 'Why do you want to work here?', required: true },
  ];
  const { plan, left } = planFill(fields, client, { cvFile: 'cv.docx' });
  const val = (id) => plan.find((p) => p.id === id)?.value;
  assert.equal(val('f1'), 'Jane');
  assert.equal(val('f2'), 'jane@example.com');
  assert.equal(val('f3'), 'No');
  assert.equal(val('f5'), 'cv.docx');
  assert.deepEqual(left.map((l) => l.id).sort(), ['f4', 'f6']);
});

test('submit buttons are recognised so the agent never clicks them', () => {
  for (const t of ['Submit', 'Submit application', 'Apply now', 'Send application']) assert.ok(SUBMIT_TEXT.test(t), t);
  assert.ok(!SUBMIT_TEXT.test('Next'));
  assert.ok(!SUBMIT_TEXT.test('Save and continue'));
});

test('Easy Apply answer sheet has the standard answers', () => {
  const a = answerSheet(client);
  assert.equal(a.needs_sponsorship, 'No');
  assert.equal(a.authorised_to_work, 'Yes');
  assert.equal(a.salary, '85000');
});

test('guard hook blocks reading session cookies and keychain secrets', () => {
  const bash = (command) => verdict({ tool_name: 'Bash', tool_input: { command } });
  assert.ok(bash('sqlite3 ~/ApplyDesk/profiles/li-jane/Default/Cookies "select * from cookies"'));
  assert.ok(bash('grep li_at -r ~/ApplyDesk'));
  assert.ok(bash('security find-generic-password -s applydesk -w'));
  assert.ok(verdict({ tool_name: 'PowerShell', tool_input: { command: 'cmdkey /list' } }));
  assert.ok(verdict({ tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\a\\ApplyDesk\\profiles\\li-jane\\Default\\Network\\Cookies' } }));
  assert.equal(bash('node applydesk.mjs jobs jane-doe'), null);
});

test('browser lookup finds Chrome then Edge on Windows', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findBrowser(env, 'win32', (p) => p === edge), edge);
  const chrome = 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findBrowser(env, 'win32', (p) => p === chrome || p === edge), chrome);
  assert.equal(findBrowser({ APPLYDESK_BROWSER: 'X' }, 'win32', () => false), 'X');
});

test('ATS detection and Resume Worded score parsing', () => {
  assert.equal(detectAts('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1'), 'workday');
  assert.equal(detectAts('https://jobs.lever.co/acme/1'), 'lever');
  assert.equal(parseScore('Your resume score is 87/100'), 87);
  assert.equal(parseScore('nothing here'), null);
});

test('data folder was the temp one, not the real home', () => {
  assert.ok(existsSync(join(process.env.APPLYDESK_HOME, 'clients', 'jane-doe', 'jobs')));
});

// ---- 0.3.0: LinkedIn pages read without LinkedIn's class names ----

const DESC = 'Northwind Traders is hiring a Senior Data Analyst to lead reporting across Canada. You will build dashboards in Power BI, write SQL against our warehouse, and automate weekly reporting with Python. 5+ years in analytics.';
const signedInSignals = {
  url: 'https://www.linkedin.com/jobs/view/4100000001/',
  doc_title: '(2) Senior Data Analyst | Northwind Traders | LinkedIn',
  og_title: '',
  h1: '',
  company_link: 'Northwind Traders',
  ld: [],
  about: `About the job\n${DESC}\nAbout the company\nNorthwind sells food.`,
  main: `Northwind Traders\nSenior Data Analyst\nToronto, ON · 3 days ago · Over 100 applicants\nHybrid\nApply\nSave\nAbout the job\n${DESC}\nAbout the company\nNorthwind sells food.\nMore jobs\nData Analyst\nContoso\nEasy Apply`,
  controls: [{ text: 'Apply', aria: 'Apply to Senior Data Analyst on company website', href: 'https://www.linkedin.com/safety/go?url=https%3A%2F%2Fjobs.example%2F42' }],
};

test('LinkedIn job: tab title formats', () => {
  assert.deepEqual(parseJobTitle('(2) Senior Data Analyst | Northwind Traders | LinkedIn'), { title: 'Senior Data Analyst', company: 'Northwind Traders', location: '' });
  assert.deepEqual(parseJobTitle('Acme hiring Data Analyst in Vancouver, BC | LinkedIn'), { company: 'Acme', title: 'Data Analyst', location: 'Vancouver, BC' });
  assert.deepEqual(parseJobTitle('LinkedIn'), { title: '', company: '', location: '' });
});

test('LinkedIn job: new signed-in layout reads title, company, location, description', () => {
  const j = parseJob(signedInSignals, '4100000001');
  assert.equal(j.title, 'Senior Data Analyst');
  assert.equal(j.company, 'Northwind Traders');
  assert.equal(j.location, 'Toronto, ON'); // not the company, not "3 days ago"
  assert.match(j.description, /^Northwind Traders is hiring/);
  assert.doesNotMatch(j.description, /About the company|Contoso/);
  assert.equal(j.complete, true);
  assert.ok(j.posted_at);
});

test('LinkedIn job: guest page uses the structured data', () => {
  const ld = JSON.stringify({ '@type': 'JobPosting', title: 'Data Analyst', datePosted: '2026-11-08T10:00:00.000Z', hiringOrganization: { name: 'Acme' }, jobLocation: { address: { addressLocality: 'Vancouver', addressRegion: 'BC', addressCountry: 'CA' } }, description: `&lt;p&gt;${DESC}&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;` });
  const j = parseJob({ doc_title: 'Acme hiring Data Analyst in Vancouver, BC | LinkedIn', ld: [ld], main: '', about: '', controls: [] }, '7');
  assert.equal(j.title, 'Data Analyst');
  assert.equal(j.company, 'Acme');
  assert.equal(j.location, 'Vancouver, BC, CA');
  assert.match(j.description, /Northwind Traders is hiring[\s\S]*- SQL/);
  assert.doesNotMatch(j.description, /<p>|&lt;/);
  assert.equal(j.posted_exact, true);
});

test('LinkedIn job: a page that could not be read is incomplete, never blank-but-ready', () => {
  const j = parseJob({ doc_title: 'LinkedIn', ld: [], main: 'Sign in to see who you already know', about: '', controls: [] }, '9');
  assert.equal(j.complete, false);
  assert.deepEqual(j.missing, ['title', 'company', 'description']);
});

test('LinkedIn job: apply route comes from the real apply button, else unknown', () => {
  assert.equal(applyRoute([{ text: 'Easy Apply', aria: 'Easy Apply to Data Analyst', href: '' }]).route, 'easy_apply');
  const ext = applyRoute(signedInSignals.controls);
  assert.equal(ext.route, 'employer_site');
  assert.equal(applyRoute([], '"companyApplyUrl":"https:\\u002F\\u002Fjobs.acme.example\\u002F1"').apply_url, 'https://jobs.acme.example/1');
  assert.equal(applyRoute([]).route, 'unknown');
  assert.equal(applyRoute([{ text: 'Easy Apply', aria: '', href: '' }], '"companyApplyUrl":"https://x.example/a"').route, 'unknown');
  // A similar-job card that says "Easy Apply" is not this job's button.
  assert.equal(parseJob(signedInSignals, '1').route, 'employer_site');
});

test('html descriptions become plain text', () => {
  assert.equal(htmlToText('<p>A &amp; B</p><ul><li>one</li></ul>'), 'A & B\n\n- one');
});

test('jobs that could not be read are saved as incomplete with a readable folder', () => {
  const r = addJob('jane-doe', { source: 'linkedin', external_id: '555', url: 'https://www.linkedin.com/jobs/view/555/', title: '', company: '', description: '' });
  const m = getJob('jane-doe', r.jobId);
  assert.equal(m.status, 'incomplete');
  assert.match(r.jobId, /linkedin-555$/);
  assert.doesNotMatch(r.jobId, /x-x/);
  assert.equal(routeOf(m), 'unknown');
});

test('job fetch fills blank, pending or fallback fields but keeps real ones', () => {
  const meta = { title: '', company: 'pending', location: '', easy_apply: null, status: 'incomplete' };
  const got = { title: 'Data Analyst', company: 'Acme', location: 'Toronto', route: 'employer_site', easy_apply: false, apply_url: 'https://a.example', complete: true, description: 'x'.repeat(300) };
  const p = mergeFetched(meta, got);
  assert.equal(p.title, 'Data Analyst');
  assert.equal(p.company, 'Acme');
  assert.equal(p.status, 'jd_ready');
  assert.equal(p.easy_apply, false);
  const kept = mergeFetched({ title: 'Edited by hand', company: 'Acme Corp', location: 'Remote', apply_url: 'https://a.example', easy_apply: true, status: 'cv_ready' }, { ...got, route: 'unknown', easy_apply: null });
  assert.deepEqual(kept, {}); // hand edits, a known route and later statuses all stay
});

test('LinkedIn job ids in the new search layout', () => {
  const ids = LI.jobIdsFromHtml('{"entityUrn":"urn:li:fsd_jobPosting:4100000001"} href="/jobs/search-results/?currentJobId=4100000002" "jobPostingId":4100000003');
  assert.deepEqual(ids.sort(), ['4100000001', '4100000002', '4100000003']);
  assert.ok(LI.allowed('https://www.linkedin.com/jobs/search-results/?keywords=analyst&infoNotice=ai-job-search'));
});

test('signed in means LinkedIn signed-in navigation, not just the address', () => {
  const base = { url: 'https://www.linkedin.com/jobs/', loginForm: false, password: false, nav: [] };
  assert.equal(LI.signedInFrom({ ...base, nav: ['join now', 'sign in'] }), false); // public jobs page
  assert.equal(LI.signedInFrom({ ...base, nav: ['home', 'my network', 'jobs', 'messaging', 'notifications', 'me'] }), true);
  assert.equal(LI.signedInFrom({ ...base, url: 'https://www.linkedin.com/login', loginForm: true, password: true }), false);
  assert.equal(LI.signedInFrom({ ...base, nav: ['messaging'], password: true }), false);
  assert.equal(LI.signedInFrom({ ...base, url: 'https://www.linkedin.com/checkpoint/challenge/x', nav: ['messaging'] }), false);
});

test('LinkedIn work needs a confirmed sign-in, not only an open sitting', () => {
  LI.endSitting('test');
  LI.startSitting('sam', { operator: 'op', present: 'Sam' });
  assert.match(LI.sittingProblem('sam'), /sign/i);
  assert.equal(LI.sittingProblem('sam', { needSignIn: false }), null);
  LI.markSignedIn('sam');
  assert.equal(LI.sittingProblem('sam'), null);
  LI.endSitting('test');
});
