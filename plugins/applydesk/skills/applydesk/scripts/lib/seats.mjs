// The operator's own seats (Resume Worded, Pacten) in the tools profile: are they
// signed in? A firm yes or no from what the page shows, "unknown" only when the
// page shows neither a sign-in form nor a signed-in account.
import { paths, readJson, writeJson } from './config.mjs';

// Runs inside the page.
export function seatSignalsInPage() {
  const said = [...document.querySelectorAll('a, button, [role=button], [role=menuitem]')]
    .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase())
    .filter((t) => t && t.length < 40);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    url: location.href,
    password: [...document.querySelectorAll('input[type="password"]')].some(visible),
    signOut: said.some((t) => /^(log ?out|sign ?out|logout|signout)$/.test(t)),
    signIn: said.some((t) => /^(log ?in|sign ?in|login|signin)$/.test(t)),
    account: Boolean(document.querySelector('[aria-label*="account" i], [aria-label*="profile" i], [class*="avatar" i], img[alt*="profile" i]')),
    upload: Boolean(document.querySelector('input[type="file"]')),
  };
}

export function seatState(s) {
  if (!s) return { state: 'unknown', why: 'the page did not load' };
  if (s.password || /\/(login|signin|sign-in|sign_in|auth)\b/i.test(s.url)) return { state: 'no', why: 'a sign-in form is showing' };
  if (s.signOut) return { state: 'yes', why: 'the page offers "Log out"' };
  if (s.signIn) return { state: 'no', why: 'the page offers "Log in"' };
  if (s.account && s.upload) return { state: 'yes', why: 'an account menu and the upload box are showing' };
  return { state: 'unknown', why: 'the page shows neither a sign-in form nor an account' };
}

const file = () => paths.state('signins.json');
export const readSignins = () => readJson(file(), {});
export function recordSignin(site, result) {
  const all = readSignins();
  all[site] = { ...result, checked_at: new Date().toISOString() };
  writeJson(file(), all);
}

// What setup still needs, from what is actually done.
export function setupNext(op, signins = readSignins()) {
  const steps = [];
  if (signins['resume-worded']?.state !== 'yes') steps.push('applydesk setup --signin resume-worded');
  if (!op.pacten_url) steps.push('applydesk setup --operator <name> --pacten-url <your Pacten address>');
  else if (signins.pacten?.state !== 'yes') steps.push('applydesk setup --signin pacten');
  if (steps.some((s) => s.includes('--signin'))) steps.push('applydesk setup --check   (after signing in)');
  return steps.length ? steps : ['Setup is done. Next: applydesk client new'];
}
