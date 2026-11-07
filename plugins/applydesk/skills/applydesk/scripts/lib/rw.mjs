// Resume Worded, through the operator's own signed-in tools profile.
// No API exists, so this drives the site at human pace: upload, wait, read the
// score. Every scan is counted against the seat's monthly cap. If the page
// layout defeats the script, the model falls back to `page` commands or the
// operator scans by hand and records the score with `rw record`.
import { paths, readJson, writeJson } from './config.mjs';

export const RW_DEFAULTS = {
  score_url: 'https://resumeworded.com/upload-resume',
  targeted_url: 'https://resumeworded.com/targeted-resume',
  monthly_cap: 250,
  warn_at: 0.8,
};

const ledger = () => paths.state('rw-ledger.json');
const month = (d = new Date()) => d.toISOString().slice(0, 7);

export function rwUsage(operatorId) {
  return readJson(ledger(), {})[month()]?.[operatorId] || 0;
}

export function rwCount(operatorId) {
  const l = readJson(ledger(), {});
  l[month()] ??= {};
  l[month()][operatorId] = (l[month()][operatorId] || 0) + 1;
  writeJson(ledger(), l);
  return l[month()][operatorId];
}

export function rwBudget(op) {
  const cfg = { ...RW_DEFAULTS, ...(op.resume_worded || {}) };
  const used = rwUsage(op.id);
  return { used, cap: cfg.monthly_cap, left: Math.max(0, cfg.monthly_cap - used), warn: used >= cfg.monthly_cap * cfg.warn_at, cfg };
}

// Pull the overall score out of the result page's text.
export function parseScore(text) {
  const t = String(text || '');
  const pats = [
    /(?:your |overall |resume |relevancy |match )?score(?: is)?[^0-9]{0,40}?(\d{1,3})\s*(?:\/\s*100|out of 100)/i,
    /(\d{1,3})\s*(?:\/\s*100|out of 100)/i,
    /score[^0-9]{0,20}(\d{1,3})\b/i,
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

export function looksSignedOut(url, text) {
  return /\/(login|signin|sign-in|register|signup)/i.test(url) || /log in to (see|view)|sign in to (see|view)|create (a )?free account to/i.test(text.slice(0, 3000));
}

export async function scan(page, { file, jd, targeted, cfg, timeoutMs = 150000 }) {
  await page.goto(targeted ? cfg.targeted_url : cfg.score_url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  let text = await page.evaluate(() => document.body.innerText);
  if (looksSignedOut(page.url(), text)) return { blocked: 'Resume Worded is signed out in the tools profile. Run: applydesk setup --signin resume-worded' };
  if (targeted && jd) {
    const box = page.locator('textarea').first();
    if (await box.count()) await box.fill(jd.slice(0, 8000));
  }
  const input = page.locator('input[type=file]').first();
  if (!(await input.count())) return { fail: 'No upload field found on the Resume Worded page (layout changed?)' };
  await input.setInputFiles(file);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await page.waitForTimeout(3000);
    text = await page.evaluate(() => document.body.innerText);
    const score = parseScore(text);
    if (score !== null && !/analy[sz]ing|uploading|processing|scanning/i.test(text.slice(0, 1500))) {
      const tips = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 25 && l.length < 220).slice(0, 25);
      return { score, url: page.url(), tips };
    }
  }
  return { fail: 'Timed out waiting for a score' };
}
