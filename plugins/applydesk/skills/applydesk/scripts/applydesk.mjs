#!/usr/bin/env node
// ApplyDesk command line. Every command prints ONE JSON line on stdout:
//   {"status":"ok|fail|blocked", "step": "...", ...}
// ok      -> continue.   fail -> retry once, then escalate the model.
// blocked -> a person is needed (sign-in, CAPTCHA, code, consent). Never escalate.
// Run `node applydesk.mjs help` for the command list.
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  paths, readJson, writeJson, loadClient, loadOperator, linkedinProfileName, applyProfileName, toolsProfileName, today, UserError, ensureDir, home,
} from './lib/config.mjs';
import { ok, fail, blocked, say } from './lib/out.mjs';
import { doctor } from './lib/doctor.mjs';
import { withProfile, closeProfile, listOpen, pickPage } from './lib/browser.mjs';
import * as LI from './lib/linkedin.mjs';
import { addJob, getJob, updateJob, listJobs, readJd, latestCv, freshness, mergeFetched, routeOf } from './lib/jobs.mjs';
import { jobSignalsInPage, parseJob } from './lib/lijob.mjs';
import { fetchBoard, matches, detectAts, ATS_NOTES } from './lib/ats.mjs';
import { checkCv, jdKeywords } from './lib/cvcheck.mjs';
import { scan as scanForm, planFill, setField, answerSheet, SUBMIT_TEXT, ATTEST } from './lib/form.mjs';
import { pactenRecord, appendCsv } from './lib/tracker.mjs';
import * as RW from './lib/rw.mjs';

const VERSION = '0.2.0';

// ---------- tiny arg parser ----------
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const multi = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------- shared guards ----------
function requireOperator() {
  const op = loadOperator();
  if (!op) throw new UserError('No operator set up on this machine. Run: applydesk setup --operator <your-name>');
  return op;
}

// `page` and `creds` work in the tools profile or a client's apply profile. Never LinkedIn.
function profileFor(who) {
  if (who === 'tools') return { profile: toolsProfileName(requireOperator().id), client: null };
  const client = loadClient(who);
  return { profile: applyProfileName(client.id), client };
}

const clientIds = () => {
  const dir = paths.clients();
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(paths.clientFile(d))) : [];
};

const isEasy = (j) => j.easy_apply === true;

// The operator's local clock, for anything a person reads.
const local = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

async function pageText(page, max = 4000) {
  return (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, max);
}

// Open a LinkedIn page for the client in the open sitting. Returns null, or a stop.
// Never navigates away from a sign-in form the client may be typing into, and
// stops (blocked) the moment a page shows LinkedIn signed out.
async function liGoto(page, client, url, { timeout = 30000 } = {}) {
  const why = LI.sittingProblem(client.id);
  if (why) return { stop: 'blocked', reason: why };
  if (!LI.allowed(url)) return { stop: 'fail', reason: `ApplyDesk only opens LinkedIn job pages, not: ${url}` };
  if (/linkedin\.com/.test(page.url()) && (await LI.checkSignedIn(page)).loginShowing) return signedOutStop(page, client);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  const text = await pageText(page);
  if (LI.isCheckpoint(page.url(), text)) {
    LI.stopForCheck(client.id, page.url());
    await page.bringToFront().catch(() => {});
    return { stop: 'blocked', reason: `LinkedIn showed a security check or warning for ${client.id}. ApplyDesk stopped and ended the sitting. The client deals with it in the open window; do not retry it with ApplyDesk today.` };
  }
  if (!(await LI.checkSignedIn(page)).signedIn) return signedOutStop(page, client);
  LI.audit(client.id, 'open', page.url());
  return null;
}

async function signedOutStop(page, client) {
  LI.markSignedOut(client.id);
  await page.bringToFront().catch(() => {});
  return { stop: 'blocked', reason: `LinkedIn is not signed in for ${client.id}. ${client.full_name}: sign in in the LinkedIn window, then run: applydesk sitting start ${client.id} --present` };
}

// One retry for a page that times out or aborts; a security check or sign-out is never retried.
async function liGotoRetry(page, client, url) {
  for (let i = 0; ; i++) {
    try {
      return await liGoto(page, client, url);
    } catch (e) {
      if (i >= 1) return { stop: 'skip', reason: e.message.split('\n')[0] };
      await page.waitForTimeout(2000);
    }
  }
}

const stopped = (step, stop, data) => (stop.stop === 'blocked' ? blocked : fail)(step, stop.reason, data);

// ---------- commands ----------
const commands = {
  async help() {
    return ok('help', {
      version: VERSION,
      data: home(),
      commands: [
        'doctor [--fix]',
        'setup --operator <name> [--pacten-url <url>] [--rw-cap <n>] | setup --signin resume-worded|pacten | setup --check',
        'client new | client edit <id> | client list | client show <id>',
        'sitting start <client> --present [--wait <seconds>]   the client is here; they sign in to LinkedIn themselves',
        'sitting status | sitting end | sitting forget <client> | sitting read <client> [--job <job>] [--max <chars>]   (read-only, for diagnosis)',
        'discover linkedin <client> [--max <n>] [--pages <n>] [--minutes <n>]   (in a sitting)',
        'discover ats <client> [--board greenhouse:<token> ...] | discover links <client> <url> [...]',
        'jobs <client> [--status <s>] [--easy|--employer|--unknown] | job show|fetch <client> <job> | job jd <client> <job> <file> [--title t] [--company c]',
        'job set <client> <job> [--title t] [--company c] [--location l] [--apply-url u] [--route easy|employer|unknown] [--status s] [--note "..."]',
        'cv brief <client> <job> | cv check <client> <job|master> | cv render <client> <job|master>',
        'rw budget | rw scan <client> <job|master> [--targeted] | rw record <client> <job|master> <score> [--targeted]',
        'apply start <client> <job> | apply ready <client> <job> | apply done <client> <job>   (employer sites)',
        'easy list <client> | easy next <client> | easy done <client> <job> [--skipped "<why>"]   (Easy Apply, in a sitting)',
        'queue | queue open <client> <job>',
        'pacten <client> <job>',
        'page goto|read|fields|set|click|upload|shot|tabs <client|tools> ...',
        'creds gen <client> <host> | creds fill <client> <host> <fieldId> | creds forget <client> <host>',
        'browser list | browser close <client|tools>',
      ],
    });
  },

  async doctor({ flags }) {
    const r = await doctor({ fix: Boolean(flags.fix) });
    for (const c of r.checks) say(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}${c.fix ? `  -> ${c.fix}` : ''}`);
    return (r.ready ? ok : fail)('doctor', r.ready ? undefined : 'Some checks failed', { linkedin_allowed: r.linkedin_allowed, failed: r.checks.filter((c) => !c.ok) });
  },

  async setup({ flags }) {
    if (flags.operator) {
      const prev = loadOperator() || {};
      const op = {
        ...prev,
        id: String(flags.operator).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        pacten_url: flags['pacten-url'] || prev.pacten_url || null,
        resume_worded: { ...RW.RW_DEFAULTS, ...(prev.resume_worded || {}), ...(flags['rw-cap'] ? { monthly_cap: Number(flags['rw-cap']) } : {}) },
        created_at: prev.created_at || new Date().toISOString(),
      };
      writeJson(paths.operator(), op);
      return ok('setup', { operator: op.id, next: 'Run: applydesk setup --signin resume-worded, then: applydesk setup --signin pacten' });
    }
    const op = requireOperator();
    const profile = toolsProfileName(op.id);
    if (flags.signin) {
      const site = String(flags.signin);
      const url = site === 'pacten' ? op.pacten_url : site === 'resume-worded' ? 'https://resumeworded.com/login' : null;
      if (!url) return fail('setup', site === 'pacten' ? 'No Pacten URL. Run: applydesk setup --operator <name> --pacten-url <url>' : 'Use --signin resume-worded or --signin pacten');
      await withProfile(profile, async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.bringToFront();
      });
      return blocked('setup', `Operator: sign in to ${site} yourself in the window that just opened. Then run: applydesk setup --check`);
    }
    if (flags.check) {
      const out = {};
      await withProfile(profile, async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(op.resume_worded?.score_url || RW.RW_DEFAULTS.score_url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        out.resume_worded = RW.looksSignedOut(page.url(), await pageText(page)) ? 'signed out' : 'signed in (probably — confirm the page shows your account)';
        if (op.pacten_url) {
          await page.goto(op.pacten_url, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          out.pacten = /login|sign.?in/i.test(page.url()) ? 'signed out' : 'signed in (probably)';
        } else out.pacten = 'no URL configured';
        await page.close();
      });
      return ok('setup', out);
    }
    return fail('setup', 'Use --operator, --signin or --check');
  },

  async client({ pos }) {
    const [sub, id] = pos;
    if (sub === 'new' || sub === 'edit') {
      const { runOnboarding, missingInfo, NEEDED } = await import('./lib/onboard.mjs');
      say('Opening the onboarding form in your browser. Fill in what you have (only ID and name are required) and click Save.');
      const c = await runOnboarding(sub === 'edit' ? id : null);
      const missing = missingInfo(c);
      return ok('client', {
        client: c.id, master_cv: Boolean(c.master_cv),
        missing: missing.map((k) => `${k} (needed for ${NEEDED[k]})`),
        next: missing.length ? `Add the rest when you have it: applydesk client edit ${c.id}` : `When the client is present: applydesk sitting start ${c.id} --present`,
      });
    }
    if (sub === 'list') {
      const open = LI.activeSitting();
      return ok('client', {
        sitting: open ? open.client : null,
        clients: clientIds().map((cid) => {
          const jobs = listJobs(cid);
          const easy = jobs.filter(isEasy);
          const employer = jobs.filter((j) => j.easy_apply === false);
          const by = (list, s) => list.filter((j) => j.status === s).length;
          return {
            id: cid,
            found: jobs.length,
            employer: { cv_ready: by(employer, 'cv_ready'), ready_for_review: by(employer, 'ready_for_review'), applied: by(employer, 'applied') },
            easy_apply: { waiting_for_sitting: easy.filter((j) => j.status === 'cv_ready').length, applied: by(easy, 'applied') },
            route_unknown: jobs.filter((j) => routeOf(j) === 'unknown').length,
            incomplete: jobs.filter((j) => j.status === 'incomplete').length,
            linkedin_hold: Boolean(LI.lastHold(cid)),
          };
        }),
      });
    }
    if (sub === 'show') {
      const c = loadClient(id);
      const { missingInfo } = await import('./lib/onboard.mjs');
      const { consent, eeo_answers, ...rest } = c;
      return ok('client', { client: rest, consent, missing: missingInfo(c), linkedin_hold: LI.lastHold(c.id) });
    }
    return fail('client', 'Use: client new | edit <id> | list | show <id>');
  },

  async sitting({ pos, flags }) {
    const [sub, id] = pos;
    if (sub === 'status') {
      const open = LI.activeSitting();
      const ends = open ? new Date(Date.parse(open.started_at) + LI.SITTING_HOURS * 3600e3).toISOString() : null;
      return ok('sitting', { open, signed_in: Boolean(open?.signed_in_at), ends_by: ends, ends_by_local: ends && local(ends), max_hours: LI.SITTING_HOURS });
    }
    if (sub === 'end') {
      const s = LI.endSitting(flags.reason || 'ended by operator');
      if (s) await closeProfile(linkedinProfileName(s.client)).catch(() => {});
      return ok('sitting', { ended: s?.client || null, note: 'The LinkedIn window is closed. The client stays signed in for their next sitting.' });
    }
    if (sub === 'forget') {
      const client = loadClient(id);
      if (LI.activeSitting()?.client === client.id) LI.endSitting('forget');
      await closeProfile(linkedinProfileName(client.id)).catch(() => {});
      rmSync(paths.profile(linkedinProfileName(client.id)), { recursive: true, force: true });
      return ok('sitting', { forgotten: client.id, next: 'The saved LinkedIn sign-in on this machine is deleted. The client can also use LinkedIn > Settings > Sign out of all sessions.' });
    }
    if (sub === 'read') return sittingRead(loadClient(id), flags);
    if (sub !== 'start') return fail('sitting', 'Use: sitting start <client> --present | status | end | forget <client> | read <client>');

    const client = loadClient(id);
    if (!flags.present) return blocked('sitting', `Only start a sitting when ${client.full_name} is here (in person or on a screen share). Then repeat with --present.`);
    const doc = readJson(paths.state('doctor.json'));
    if (!doc?.linkedin_allowed) return blocked('sitting', 'This machine has not passed the safety checks for keeping sign-ins. Run: applydesk doctor --fix');
    if (!client.consent?.linkedin_session) return blocked('sitting', `No LinkedIn consent recorded for ${client.id}. Re-run: applydesk client edit ${client.id}`);
    const op = requireOperator();
    const r = LI.startSitting(client.id, { operator: op.id, present: client.full_name });
    if (r.error) return blocked('sitting', r.error);
    const hold = LI.lastHold(client.id);
    // Short by default so the command returns before an agent's tool timeout; run it again to re-check.
    const waitMs = Math.max(0, Math.min(540, Number(flags.wait ?? 90))) * 1000;

    const state = await withProfile(linkedinProfileName(client.id), async (ctx) => {
      const page = await pickPage(ctx, 'linkedin.com');
      await page.bringToFront().catch(() => {});
      let seen = /linkedin\.com/.test(page.url()) ? await LI.checkSignedIn(page) : null;
      // Never reload over a sign-in form the client may be typing into.
      if (!seen?.signedIn && !seen?.loginShowing) {
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        if (LI.isCheckpoint(page.url(), await pageText(page))) return 'check';
        seen = await LI.checkSignedIn(page);
        if (!seen.signedIn && !seen.loginShowing) {
          await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
          seen = await LI.checkSignedIn(page);
        }
      }
      if (seen.signedIn) return 'signed in';
      say(`${client.full_name}: please sign in to LinkedIn yourself in the window that just opened (and approve any 2-step check).`);
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        await page.waitForTimeout(3000);
        if (LI.isCheckpoint(page.url(), '')) continue; // a 2-step check is the client's to finish
        if ((await LI.checkSignedIn(page)).signedIn) return 'signed in now';
      }
      return 'signed out';
    });
    if (state === 'check') {
      LI.stopForCheck(client.id, 'https://www.linkedin.com/feed/');
      return blocked('sitting', `LinkedIn showed a security check for ${client.id}. The client deals with it in the open window; do not retry with ApplyDesk today.`);
    }
    if (state === 'signed out') {
      return blocked('sitting', `${client.full_name}: sign in to LinkedIn now, in the window that is open (approve any 2-step check). ApplyDesk will not load any LinkedIn page until you have. When the feed or jobs page shows, run: applydesk sitting start ${client.id} --present`, { client: client.id, state: 'waiting for sign-in' });
    }
    LI.markSignedIn(client.id);
    if (hold) LI.clearHold(client.id);
    LI.audit(client.id, 'sitting', 'https://www.linkedin.com/feed/', { state, operator: op.id });
    const waiting = listJobs(client.id, 'cv_ready').filter(isEasy).length;
    const ends = new Date(Date.parse(r.sitting.started_at) + LI.SITTING_HOURS * 3600e3).toISOString();
    return ok('sitting', {
      client: client.id, state, resumed: r.resumed, ends_by: ends, ends_by_local: local(ends),
      previous_check: hold ? `Last sitting stopped on a LinkedIn check at ${local(hold.at)}. Ask the client if their account is fine before searching.` : undefined,
      next: [`applydesk discover linkedin ${client.id}`, waiting ? `applydesk easy next ${client.id}   (${waiting} Easy Apply jobs have CVs ready)` : null, 'applydesk sitting end   (when the client leaves)'].filter(Boolean),
    });
  },

  async discover({ pos, flags }) {
    const [src, id, ...rest] = pos;
    const client = loadClient(id);
    if (src === 'ats') {
      const boards = [...multi(flags.board), ...(client.ats_boards || [])];
      if (!boards.length) return fail('discover', 'No boards. Pass --board greenhouse:<token> (or lever:/ashby:), or add "ats_boards" to the client.');
      let added = 0;
      const errors = [];
      for (const b of boards) {
        const [kind, token] = b.split(':');
        try {
          const jobs = (await fetchBoard(kind, token)).filter((j) => matches(j, client));
          for (const j of jobs) if (addJob(client.id, j).created) added++;
        } catch (e) {
          errors.push(`${b}: ${e.message}`);
        }
      }
      return ok('discover', { source: 'ats', added, errors });
    }
    if (src === 'links') {
      let added = 0;
      for (const url of rest) {
        const li = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
        const r = addJob(client.id, { source: li ? 'linkedin' : 'link', external_id: li?.[1] || url, url, title: '', company: '' });
        if (r.created) added++;
      }
      return ok('discover', { source: 'links', added, next: `applydesk job fetch ${client.id} <job> for each new job (LinkedIn links: in a sitting)` });
    }
    if (src !== 'linkedin') return fail('discover', 'Use: discover linkedin|ats|links <client>');

    if (!client.target_titles?.length) return blocked('discover', `No target job titles for ${client.id} yet. Add them: applydesk client edit ${client.id}`);
    const why = LI.sittingProblem(client.id);
    if (why) return blocked('discover', why);
    const max = Math.max(1, Number(flags.max || 10));
    const pages = Math.max(1, Math.min(4, Number(flags.pages || 1)));
    // Stop in time to report: agents' shell tools time out at about 10 minutes.
    const until = Date.now() + Math.max(1, Math.min(9, Number(flags.minutes || 7))) * 60e3;
    const summary = { searched: 0, read: 0, added: 0, easy_apply: 0, employer_site: 0, route_unknown: 0, incomplete: 0, skipped: 0, failed: 0 };
    const problems = [];
    const done = (extra = {}) => ok('discover', {
      source: 'linkedin', ...summary, ...extra, problems: problems.slice(0, 8),
      next: summary.incomplete ? 'Incomplete jobs: job fetch <client> <job> in a sitting, or job set --title/--company plus job jd. Then cv brief / check / render / rw scan.' : 'For each new job: cv brief / cv check / cv render / rw scan. Employer-site jobs need no sitting; Easy Apply jobs wait for: easy next',
    });
    return withProfile(linkedinProfileName(client.id), async (ctx) => {
      const page = await pickPage(ctx, 'linkedin.com');
      const ids = [];
      for (const title of client.target_titles) {
        for (let p = 0; p < pages && Date.now() < until; p++) {
          const url = LI.searchUrl({ keywords: title, location: client.locations?.[0] || client.country, remote: client.remote, days: Math.min(14, client.max_age_days || 14), start: p * 25 });
          const stop = await liGotoRetry(page, client, url);
          if (stop?.stop === 'skip') {
            summary.failed++;
            problems.push(`search "${title}" page ${p + 1}: ${stop.reason}`);
            continue;
          }
          if (stop) return stopped('discover', stop, summary);
          summary.searched++;
          // The results list loads as it scrolls into view.
          for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 1200);
            await page.waitForTimeout(800);
          }
          ids.push(...LI.jobIdsFromHtml(await page.content()));
        }
      }
      const index = readJson(join(paths.jobs(client.id), 'index.json'), {});
      const fresh = [...new Set(ids)].filter((jid) => !index[`linkedin:${jid}`]);
      let looked = 0;
      for (const jid of fresh) {
        if (looked >= max || Date.now() > until) break;
        looked++;
        const stop = await liGotoRetry(page, client, LI.viewUrl(jid));
        if (stop?.stop === 'skip') {
          summary.failed++;
          problems.push(`job ${jid}: ${stop.reason}`);
          continue;
        }
        if (stop) return stopped('discover', stop, summary);
        summary.read++;
        const job = await extractLinkedinJob(page, jid);
        const title = (job.title || '').toLowerCase();
        if (job.closed || (client.excluded_keywords || []).some((k) => title.includes(k.toLowerCase())) || (client.excluded_employers || []).some((e) => job.company?.toLowerCase().includes(e.toLowerCase()))) {
          summary.skipped++;
          continue;
        }
        // Saved as it goes, so a later failure loses nothing. Unreadable pages are kept as "incomplete".
        if (addJob(client.id, job).created) {
          summary.added++;
          if (!job.complete) summary.incomplete++;
          summary[{ easy_apply: 'easy_apply', employer_site: 'employer_site' }[job.route] || 'route_unknown']++;
        }
      }
      return done({ more_available: fresh.length > looked });
    });
  },

  async jobs({ pos, flags }) {
    let list = listJobs(pos[0], flags.status);
    if (flags.easy) list = list.filter(isEasy);
    if (flags.employer) list = list.filter((j) => j.easy_apply === false);
    if (flags.unknown) list = list.filter((j) => routeOf(j) === 'unknown');
    const jobs = list.map((j) => ({ job: j.job_id, title: j.title, company: j.company, status: j.status, route: routeOf(j), age: j.age_days_when_found, ats: j.ats, rw: j.resume_worded_score, check: j.local_check_score }));
    return ok('jobs', { count: jobs.length, jobs: jobs.slice(0, Number(flags.limit || 50)) });
  },

  async job({ pos, flags }) {
    const [sub, id, jobId, file] = pos;
    const client = loadClient(id);
    if (sub === 'show') return ok('job', { meta: getJob(client.id, jobId), jd_chars: readJd(client.id, jobId).length });
    if (sub === 'set' || sub === 'jd') {
      const meta = getJob(client.id, jobId);
      const patch = {};
      for (const k of ['title', 'company', 'location']) if (typeof flags[k] === 'string') patch[k] = flags[k].trim();
      if (typeof flags['apply-url'] === 'string') patch.apply_url = flags['apply-url'].trim();
      if (flags.route) {
        const route = { easy: true, easy_apply: true, employer: false, employer_site: false, unknown: null }[flags.route];
        if (route === undefined) return fail('job', 'Use --route easy|employer|unknown');
        patch.easy_apply = route;
      }
      if (flags.status) patch.status = flags.status;
      const jdFile = join(paths.job(client.id, jobId), 'jd.md');
      if (sub === 'jd') {
        if (!file || !existsSync(file)) return fail('job', 'Give a text file with the job description: job jd <client> <job> <file> [--title t] [--company c]');
        const body = readFileSync(file, 'utf8').trim();
        if (body.length < 200) return fail('job', 'That description is under 200 characters. Paste the whole "About the job" text into the file.');
        writeFileSync(jdFile, `# ${patch.title || meta.title} — ${patch.company || meta.company}\n\n${body}\n`);
      }
      const next = { ...meta, ...patch };
      const named = next.title?.trim() && next.company?.trim();
      // A job becomes ready for CV work once it has a title, a company and a description.
      if (!flags.status && ['incomplete', 'found'].includes(meta.status)) patch.status = named && existsSync(jdFile) ? 'jd_ready' : 'incomplete';
      const m = updateJob(client.id, jobId, patch, flags.note || (sub === 'jd' ? 'description added by hand' : Object.keys(patch).length ? `set by hand: ${Object.keys(patch).join(', ')}` : undefined));
      return ok('job', { job: jobId, title: m.title, company: m.company, location: m.location, route: routeOf(m), status: m.status });
    }
    if (sub === 'fetch') {
      const meta = getJob(client.id, jobId);
      const isLi = /linkedin\.com\/jobs\/view/.test(meta.url);
      if (isLi) {
        const why = LI.sittingProblem(client.id);
        if (why) return blocked('job', `${why}  (Or paste the description into a file and run: applydesk job jd ${client.id} ${jobId} <file>)`);
      }
      return withProfile(isLi ? linkedinProfileName(client.id) : applyProfileName(client.id), async (ctx) => {
        const page = isLi ? await pickPage(ctx, 'linkedin.com') : await ctx.newPage();
        let job;
        if (isLi) {
          const stop = await liGoto(page, client, meta.url);
          if (stop) return stopped('job', stop);
          job = await extractLinkedinJob(page, meta.external_id);
        } else {
          await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(2000);
          const text = await mainText(page);
          job = { title: (await page.title()).split(/[|\-–]/)[0].trim(), description: text, apply_url: meta.url, easy_apply: false };
        }
        const patch = mergeFetched(meta, job);
        if (job.description?.length >= 200) {
          writeFileSync(join(paths.job(client.id, jobId), 'jd.md'), `# ${patch.title || meta.title} — ${patch.company || meta.company}\n\n${job.description}\n`);
        }
        const fr = freshness(job.posted_at);
        const m = updateJob(client.id, jobId, {
          ...patch,
          ats: detectAts(patch.apply_url || meta.apply_url),
          ...(job.posted_at && !meta.posted_at ? { posted_at: job.posted_at, age_days_when_found: fr.age_days, freshness_priority: fr.priority } : {}),
        });
        if (!isLi) await page.close().catch(() => {});
        const missing = [!m.title && 'title', !m.company && 'company', !(job.description?.length >= 200) && 'description'].filter(Boolean);
        if (missing.length) {
          return fail('job', `Could not read the ${missing.join(', ')} from the page. Look with: applydesk sitting read ${client.id} --job ${jobId}. Or set it by hand: job set ${client.id} ${jobId} --title "..." --company "...", and job jd ${client.id} ${jobId} <file>`, { url: page.url(), missing, status: m.status });
        }
        return ok('job', { job: jobId, title: m.title, company: m.company, route: routeOf(m), ats: m.ats, status: m.status, jd_chars: job.description.length });
      });
    }
    return fail('job', 'Use: job show|fetch|jd|set <client> <job>');
  },

  async cv({ pos }) {
    const [sub, id, target] = pos;
    const client = loadClient(id);
    const master = client.master_cv?.md && existsSync(client.master_cv.md) ? readFileSync(client.master_cv.md, 'utf8') : null;
    if (!master) return blocked('cv', `No master CV for ${id}. Re-run: applydesk client edit ${id} and upload a .docx`);
    const isMaster = target === 'master';
    const dir = isMaster ? join(paths.client(id), 'cv') : paths.job(id, target);
    if (sub === 'brief') {
      if (getJob(id, target).status === 'incomplete') return blocked('cv', `This job's details are incomplete. Run: applydesk job fetch ${id} ${target} (in a sitting), or job set ${id} ${target} --title "..." --company "..." and job jd ${id} ${target} <file>`);
      const jd = readJd(id, target);
      if (!jd) return blocked('cv', `No job description yet. Run: applydesk job fetch ${id} ${target}`);
      const cv = latestCv(id, target);
      const next = (cv?.version || 0) + 1;
      return ok('cv', {
        master_md: client.master_cv.md, jd_md: join(dir, 'jd.md'), write_to: join(dir, `cv-${next}.md`),
        jd_keywords: jdKeywords(jd, 25), rules: 'references/cv-rules.md', considerations: client.considerations || undefined,
      });
    }
    if (sub === 'check') {
      const file = isMaster ? client.master_cv.md : latestCv(id, target)?.md;
      if (!file) return blocked('cv', `No tailored CV yet. Write cv-1.md first (see: applydesk cv brief ${id} ${target})`);
      const r = checkCv({ tailored: readFileSync(file, 'utf8'), master, jd: isMaster ? '' : readJd(id, target) });
      writeJson(file.replace(/\.md$/, '.check.json'), r);
      if (!isMaster) updateJob(id, target, { local_check_score: r.score, cv_version: latestCv(id, target).version });
      return (r.pass ? ok : fail)('cv', r.pass ? undefined : 'Local check not passed: fix the high/medium issues, write the next cv-N.md, check again', r);
    }
    if (sub === 'render') {
      const { markdownToDocx } = await import('./lib/docs.mjs');
      const cv = isMaster ? { md: client.master_cv.md, docx: join(dir, 'master-clean.docx') } : latestCv(id, target);
      if (!cv) return blocked('cv', 'No tailored CV to render');
      await markdownToDocx(cv.md, cv.docx);
      // A tidy file name for the person attaching it by hand.
      let named;
      if (!isMaster) {
        named = join(dir, `${client.full_name.replace(/[^A-Za-z0-9]+/g, '_')}_CV.docx`);
        copyFileSync(cv.docx, named);
        updateJob(id, target, { status: 'cv_ready', cv_file: named });
      }
      return ok('cv', { docx: named || cv.docx });
    }
    return fail('cv', 'Use: cv brief|check|render <client> <job|master>');
  },

  async rw({ pos, flags }) {
    const [sub, id, target, score] = pos;
    const op = requireOperator();
    const budget = RW.rwBudget(op);
    if (sub === 'budget') return ok('rw', { used: budget.used, cap: budget.cap, left: budget.left, warn: budget.warn });
    const client = loadClient(id);
    if (!client.consent?.cv_upload) return blocked('rw', `No consent to upload ${id}'s CV to Resume Worded`);
    const isMaster = target === 'master';
    const save = (n, extra = {}) => {
      if (isMaster) {
        client.master_cv.rw_score = n;
        client.master_cv.rw_scored_at = new Date().toISOString();
        writeJson(paths.clientFile(id), client);
      } else updateJob(id, target, { resume_worded_score: n, resume_worded_mode: flags.targeted ? 'targeted' : 'general' }, `Resume Worded ${n}`);
      writeJson(join(isMaster ? join(paths.client(id), 'cv') : paths.job(id, target), 'rw.json'), { score: n, targeted: Boolean(flags.targeted), at: new Date().toISOString(), ...extra });
    };
    if (sub === 'record') {
      save(Number(score), { by: 'operator' });
      RW.rwCount(op.id);
      return ok('rw', { score: Number(score), left: RW.rwBudget(op).left });
    }
    if (sub === 'scan') {
      if (budget.left <= 0) return blocked('rw', `Resume Worded monthly cap reached (${budget.cap}). Use the local check only until next month.`);
      const docx = isMaster ? client.master_cv.docx : latestCv(id, target)?.docx;
      if (!docx || !existsSync(docx)) return blocked('rw', `Render the CV first: applydesk cv render ${id} ${target}`);
      const r = await withProfile(toolsProfileName(op.id), async (ctx) => {
        const page = await ctx.newPage();
        try {
          return await RW.scan(page, { file: docx, jd: isMaster ? '' : readJd(id, target), targeted: Boolean(flags.targeted), cfg: budget.cfg });
        } finally {
          await page.close().catch(() => {});
        }
      });
      if (r.blocked) return blocked('rw', r.blocked);
      if (r.fail) return fail('rw', `${r.fail}. Fallback: scan by hand in the tools window and run: applydesk rw record ${id} ${target} <score>`);
      RW.rwCount(op.id);
      save(r.score, { tips: r.tips });
      const target_ = flags.targeted ? 80 : 90;
      return ok('rw', { score: r.score, meets_target: r.score >= target_, target: target_, tips: r.tips.slice(0, 12), left: RW.rwBudget(op).left, warn: RW.rwBudget(op).warn });
    }
    return fail('rw', 'Use: rw budget|scan|record');
  },

  // Employer-site applications. No LinkedIn and no sitting needed.
  async apply({ pos }) {
    const [sub, id, jobId] = pos;
    const client = loadClient(id);
    const meta = getJob(client.id, jobId);
    if (isEasy(meta) || /linkedin\.com/.test(meta.apply_url || '')) return blocked('apply', `This is an Easy Apply job. It is done with the client in a sitting: applydesk easy next ${client.id}`);
    if (!meta.apply_url) return blocked('apply', `No employer application link saved for this job. Run: applydesk job fetch ${client.id} ${jobId}`);
    const profile = applyProfileName(client.id);
    const host = new URL(meta.apply_url).host;

    if (sub === 'start') {
      const cv = latestCv(client.id, jobId);
      if (!cv || !existsSync(cv.docx)) return blocked('apply', `Render the tailored CV first: applydesk cv render ${id} ${jobId}`);
      return withProfile(profile, async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(meta.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        const res = await fillPage(page, client, { cvFile: meta.cv_file || cv.docx });
        updateJob(client.id, jobId, { status: 'filling', ats: detectAts(page.url()) }, `form filled ${res.filled}, left ${res.left.length}`);
        return ok('apply', { ats: detectAts(page.url()), url: page.url(), ...res, ats_note: ATS_NOTES[detectAts(page.url())], next: res.left.length ? 'Answer the left fields with page set/click (use page click --text "Next" to move between pages), then apply ready' : 'apply ready' });
      });
    }
    if (sub === 'ready') {
      return withProfile(profile, async (ctx) => {
        const page = await pickPage(ctx, host);
        const fields = await scanForm(page);
        const empty = fields.filter((f) => f.required && !f.value);
        if (empty.length) return fail('apply', 'Required fields still empty', { left: empty.map(compactField) });
        const ev = ensureDir(join(paths.job(client.id, jobId), 'evidence'));
        const shot = join(ev, 'before-submit.png');
        await page.screenshot({ path: shot, fullPage: true });
        updateJob(client.id, jobId, { status: 'ready_for_review' }, 'ready for a person to review and submit');
        return ok('apply', { job_status: 'ready_for_review', evidence: shot, next: 'A person reviews it (applydesk queue open), ticks any declarations, clicks Submit, then: applydesk apply done' });
      });
    }
    if (sub === 'done') {
      return withProfile(profile, async (ctx) => {
        const page = await pickPage(ctx, host);
        const ev = ensureDir(join(paths.job(client.id, jobId), 'evidence'));
        const shot = join(ev, 'confirmation.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const text = await pageText(page, 3000);
        const confirmed = /thank you|application (has been )?(received|submitted)|we.?ve received|successfully submitted|application complete/i.test(text);
        const out = logApplied(client, jobId, confirmed ? 'submitted, confirmation seen' : 'marked applied (no confirmation text seen)', { confirmation_seen: confirmed });
        await page.close().catch(() => {});
        return ok('apply', { applied: jobId, confirmation_seen: confirmed, evidence: shot, ...out });
      });
    }
    return fail('apply', 'Use: apply start|ready|done <client> <job>');
  },

  // Easy Apply: guided, one job at a time, with the client present. ApplyDesk
  // opens the job and lays out the CV and answers; the client does the rest.
  async easy({ pos, flags }) {
    const [sub, id, jobId] = pos;
    const client = loadClient(id);
    const all = listJobs(client.id).filter(isEasy);
    if (sub === 'list') {
      const waiting = all.filter((j) => j.status === 'cv_ready');
      return ok('easy', {
        cv_ready: waiting.map((j) => ({ job: j.job_id, title: j.title, company: j.company })),
        needs_cv: all.filter((j) => ['found', 'jd_ready'].includes(j.status)).length,
        applied: all.filter((j) => j.status === 'applied').length,
      });
    }
    if (sub === 'next') {
      const why = LI.sittingProblem(client.id);
      if (why) return blocked('easy', why);
      const next = all.find((j) => j.status === 'cv_ready');
      if (!next) {
        const needs = all.filter((j) => ['found', 'jd_ready'].includes(j.status)).length;
        return ok('easy', { done: true, note: needs ? `No Easy Apply job has a CV ready; ${needs} still need one (cv brief/check/render).` : 'All Easy Apply jobs are done.' });
      }
      return withProfile(linkedinProfileName(client.id), async (ctx) => {
        const page = await pickPage(ctx, 'linkedin.com');
        const stop = await liGoto(page, client, next.url);
        if (stop) return stopped('easy', stop);
        await page.bringToFront();
        updateJob(client.id, next.job_id, { status: 'with_client' }, 'opened for Easy Apply');
        const left = all.filter((j) => j.status === 'cv_ready').length - 1;
        return blocked('easy', `Opened "${next.title}" at ${next.company} on LinkedIn. ${client.full_name}: click Easy Apply, attach the CV below, check each answer, and click Submit yourself.`, {
          job: next.job_id, cv: next.cv_file || latestCv(client.id, next.job_id)?.docx, answers: answerSheet(client), left_after_this: left,
          then: `applydesk easy done ${client.id} ${next.job_id}   (or --skipped "<why>")`,
        });
      });
    }
    if (sub === 'done') {
      if (flags.skipped) {
        updateJob(client.id, jobId, { status: 'skipped' }, `Easy Apply skipped: ${flags.skipped}`);
        return ok('easy', { skipped: jobId, next: `applydesk easy next ${client.id}` });
      }
      const out = logApplied(client, jobId, 'Easy Apply submitted by the client', { confirmation_seen: false });
      return ok('easy', { applied: jobId, ...out, next: `applydesk easy next ${client.id}` });
    }
    return fail('easy', 'Use: easy list|next <client> | easy done <client> <job> [--skipped "<why>"]');
  },

  async queue({ pos }) {
    if (pos[0] === 'open') {
      const [, id, jobId] = pos;
      const meta = getJob(id, jobId);
      await withProfile(applyProfileName(id), async (ctx) => {
        const page = await pickPage(ctx, new URL(meta.apply_url).host);
        await page.bringToFront();
      });
      return ok('queue', { open: `${id}/${jobId}`, person: `Check every field, tick any declaration yourself, click Submit, then run: applydesk apply done ${id} ${jobId}` });
    }
    const ids = clientIds();
    const review = ids.flatMap((cid) => listJobs(cid, 'ready_for_review').map((j) => ({ client: cid, job: j.job_id, title: j.title, company: j.company, ats: j.ats })));
    const easy = ids.map((cid) => ({ client: cid, waiting: listJobs(cid, 'cv_ready').filter(isEasy).length })).filter((x) => x.waiting);
    return ok('queue', { submit_now: review, easy_apply_next_sitting: easy, open_sitting: LI.activeSitting()?.client || null });
  },

  async pacten({ pos }) {
    const [id, jobId] = pos;
    const op = requireOperator();
    const record = readJson(join(paths.job(id, jobId), 'pacten.json'));
    if (!record) return blocked('pacten', 'Not applied yet (no record). Run apply done or easy done first.');
    if (!op.pacten_url) return ok('pacten', { record, note: 'No Pacten URL set; the record is in logs/applications.csv. Set one with setup --pacten-url.' });
    await withProfile(toolsProfileName(op.id), async (ctx) => {
      const page = await pickPage(ctx, new URL(op.pacten_url).host);
      if (!page.url().startsWith(op.pacten_url)) await page.goto(op.pacten_url, { waitUntil: 'domcontentloaded' });
    });
    return ok('pacten', { record, next: 'In Pacten (tools profile): open the client, add an application, and enter these fields with page fields tools / page set tools <id> <value>, then click Save.' });
  },

  async page({ pos, flags }) {
    const [sub, who, ...rest] = pos;
    const { profile } = profileFor(who);
    return withProfile(profile, async (ctx) => {
      const page = await pickPage(ctx, flags.tab);
      if (sub === 'goto') {
        const url = rest[0];
        if (/linkedin\.com/.test(url)) return fail('page', 'page commands do not open LinkedIn. LinkedIn is only used in a sitting (discover linkedin, job fetch, easy next).');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        return ok('page', { url: page.url(), title: await page.title() });
      }
      if (sub === 'tabs') return ok('page', { tabs: ctx.pages().map((p, i) => ({ i, url: p.url() })) });
      if (sub === 'read') {
        const text = flags.all ? await pageText(page, Number(flags.max || 6000)) : await mainText(page, Number(flags.max || 4000));
        return ok('page', { url: page.url(), text });
      }
      if (sub === 'fields') {
        const fields = await scanForm(page);
        return ok('page', { url: page.url(), fields: fields.map(compactField) });
      }
      if (sub === 'set') {
        const [fid, ...v] = rest;
        const fields = await scanForm(page); // re-tag fields so ids are current
        const f = fields.find((x) => x.id === fid);
        if (f && ATTEST.test(f.label)) return blocked('page', `"${f.label.slice(0, 80)}" is a declaration. A person reads and ticks it when reviewing.`);
        await setField(page, fid, v.join(' '));
        return ok('page', { set: fid });
      }
      if (sub === 'upload') {
        await scanForm(page);
        await setField(page, rest[0], resolve(rest[1]), 'file');
        return ok('page', { uploaded: rest[1] });
      }
      if (sub === 'click') {
        const loc = flags.id ? page.locator(`[data-ad-id="${flags.id}"]`) : page.getByRole('button', { name: String(flags.text), exact: false }).or(page.getByRole('link', { name: String(flags.text), exact: false })).first();
        if (!(await loc.count())) return fail('page', `Nothing to click matching ${flags.id || flags.text}`);
        const info = await loc.first().evaluate((el) => ({ text: (el.innerText || el.value || '').trim().slice(0, 80), type: (el.getAttribute('type') || '').toLowerCase() }));
        const isFinal = (info.type === 'submit' && SUBMIT_TEXT.test(info.text)) || /submit|send application|finish/i.test(info.text);
        if (isFinal) return blocked('page', `"${info.text}" looks like the final submit. A person clicks that: run apply ready, then review it in the queue.`);
        await loc.first().click();
        await page.waitForTimeout(1500);
        return ok('page', { clicked: info.text, url: page.url() });
      }
      if (sub === 'shot') {
        const file = join(ensureDir(paths.state('shots')), `${Date.now()}.png`);
        await page.screenshot({ path: file });
        return ok('page', { file, note: 'Look at this only when text and fields are not enough: images cost far more tokens.' });
      }
      return fail('page', 'Use: page goto|read|fields|set|click|upload|shot|tabs');
    });
  },

  // Passwords for employer accounts ApplyDesk creates (e.g. Workday), never the client's own.
  async creds({ pos }) {
    const [sub, id, host, fid] = pos;
    const C = await import('./lib/creds.mjs');
    loadClient(id);
    if (sub === 'gen') {
      if (C.exists(id, host)) return ok('creds', { stored: true, created: false });
      C.store(id, host, C.generatePassword());
      return ok('creds', { stored: true, created: true, note: 'Password saved in the OS keychain. It is never shown.' });
    }
    if (sub === 'fill') {
      await withProfile(applyProfileName(id), async (ctx) => {
        const page = await pickPage(ctx, host);
        await scanForm(page);
        await page.locator(`[data-ad-id="${fid}"]`).first().fill(C.reveal(id, host));
      });
      return ok('creds', { filled: fid });
    }
    if (sub === 'forget') {
      C.forget(id, host);
      return ok('creds', { forgotten: host });
    }
    return fail('creds', 'Use: creds gen|fill|forget <client> <host> [fieldId]');
  },

  async browser({ pos }) {
    if (pos[0] === 'list') return ok('browser', { profiles: await listOpen() });
    if (pos[0] === 'close') return ok('browser', { closed: await closeProfile(profileFor(pos[1]).profile) });
    return fail('browser', 'Use: browser list | browser close <client|tools>');
  },
};

// Applied: update the job, write the Pacten record and the CSV row.
function logApplied(client, jobId, note, extra = {}) {
  const m = updateJob(client.id, jobId, { status: 'applied', date_applied: today(), ...extra }, note);
  const record = pactenRecord(m, client, { jdPath: join(paths.job(client.id, jobId), 'jd.md') });
  writeJson(join(paths.job(client.id, jobId), 'pacten.json'), record);
  const csv = appendCsv(record);
  return { csv, pacten: `applydesk pacten ${client.id} ${jobId}` };
}

// ---------- page helpers ----------
const compactField = (f) => {
  const o = { id: f.id, label: f.label, type: f.type };
  if (f.required) o.required = true;
  if (f.options) o.options = f.options.slice(0, 25);
  if (f.value) o.value = f.value;
  if (f.why) o.why = f.why;
  return o;
};

async function mainText(page, max = 4000) {
  const t = await page.evaluate(() => {
    const pick = document.querySelector('main, [role=main], article, #content, .content') || document.body;
    return pick.innerText;
  }).catch(() => '');
  return t.replace(/\n{3,}/g, '\n\n').slice(0, max);
}

async function fillPage(page, client, ctx) {
  let filled = 0;
  let left = [];
  for (let pass = 0; pass < 2; pass++) {
    const fields = await scanForm(page);
    const { plan, left: l } = planFill(fields, client, ctx);
    for (const p of plan) {
      try {
        await setField(page, p.id, p.value, p.type);
        filled++;
        await page.waitForTimeout(200); // let dependent fields appear
      } catch {}
    }
    left = l;
    if (!plan.length) break;
  }
  return { filled, left: left.map(compactField) };
}

async function extractLinkedinJob(page, jid) {
  // The description and apply button can render a moment after the page loads.
  let job;
  for (let i = 0; i < 3; i++) {
    const sig = await page.evaluate(jobSignalsInPage);
    job = parseJob(sig, jid, await page.content());
    if (job.complete && job.route !== 'unknown') break;
    await page.waitForTimeout(1500);
  }
  return job;
}

// Read-only look at the client's LinkedIn window, for working out what went wrong.
// Clicks nothing; navigates only to one of the client's saved LinkedIn jobs.
async function sittingRead(client, flags) {
  const why = LI.sittingProblem(client.id, { needSignIn: false });
  if (why) return blocked('sitting', why);
  return withProfile(linkedinProfileName(client.id), async (ctx) => {
    const page = await pickPage(ctx, 'linkedin.com');
    if (flags.job) {
      const meta = getJob(client.id, String(flags.job));
      if (!/linkedin\.com\/jobs\/view/.test(meta.url)) return fail('sitting', 'That job is not a LinkedIn job');
      const stop = await liGoto(page, client, meta.url);
      if (stop) return stopped('sitting', stop);
    }
    const url = page.url();
    if (!/linkedin\.com/.test(url)) return ok('sitting', { url, note: 'The LinkedIn window is not on a LinkedIn page.' });
    if (!LI.allowed(url) && !LI.isCheckpoint(url)) return fail('sitting', `sitting read only reads LinkedIn job and sign-in pages, not: ${url}`);
    const sign = await LI.checkSignedIn(page);
    const out = { url, title: await page.title(), signed_in: sign.signedIn, sign_in_form_showing: sign.loginShowing };
    const m = url.match(/\/jobs\/view\/(\d+)/) || url.match(/currentJobId=(\d+)/);
    if (m) {
      const j = parseJob(await page.evaluate(jobSignalsInPage), m[1], await page.content());
      out.job = { title: j.title, company: j.company, location: j.location, route: j.route, apply_url: j.apply_url || undefined, description_chars: j.description.length, missing: j.missing };
    }
    out.text = await mainText(page, Number(flags.max || 3000));
    return ok('sitting', out);
  });
}

// ---------- main ----------
const { pos, flags } = parse(process.argv.slice(2));
const name = pos.shift() || 'help';
const fn = commands[name];
try {
  if (!fn) fail('cli', `Unknown command "${name}". Run: applydesk help`);
  else await fn({ pos, flags });
} catch (e) {
  if (e instanceof UserError) blocked(name, e.message, e.extra);
  else fail(name, e.message.split('\n')[0]);
  process.exitCode = 0;
}
