// Employer application systems: recognise them from a URL, and read the
// public job-board feeds (Greenhouse, Lever, Ashby) that need no key.

export function detectAts(url) {
  const u = String(url || '').toLowerCase();
  if (/greenhouse\.io|gh_jid=/.test(u)) return 'greenhouse';
  if (/jobs\.lever\.co|lever\.co\//.test(u)) return 'lever';
  if (/ashbyhq\.com/.test(u)) return 'ashby';
  if (/myworkdayjobs\.com|workday\.com|wd\d+\.myworkday/.test(u)) return 'workday';
  if (/icims\.com/.test(u)) return 'icims';
  if (/taleo\.net|oraclecloud\.com\/hcmui|fa\.\w+\.oraclecloud/.test(u)) return 'oracle';
  if (/successfactors|sapsf|jobs\.sap\.com/.test(u)) return 'successfactors';
  if (/smartrecruiters\.com/.test(u)) return 'smartrecruiters';
  if (/workable\.com/.test(u)) return 'workable';
  if (/bamboohr\.com/.test(u)) return 'bamboohr';
  if (/linkedin\.com\/jobs/.test(u)) return 'linkedin';
  return 'other';
}

// What usually blocks automation on each system (see references/apply.md).
export const ATS_NOTES = {
  workday: 'Needs a candidate account per employer + email verification. Use "creds gen" for the password; the operator handles the email code.',
  successfactors: 'Account or sign-in required; may use an email one-time code.',
  oracle: 'Email/SMS one-time code before applying; hCaptcha possible.',
  icims: 'Account depends on employer; some allow social sign-in.',
  greenhouse: 'No account. Invisible reCAPTCHA may fall back to an email code.',
  lever: 'No account. hCaptcha may appear for suspected bots.',
  ashby: 'No account. Strict spam settings can silently reject — keep pace human.',
};

export function boardUrl(kind, token) {
  if (kind === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  if (kind === 'lever') return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  if (kind === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  throw new Error(`Unknown board type "${kind}" (use greenhouse, lever or ashby)`);
}

const strip = (html) =>
  String(html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<(br|\/p|\/li|\/h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// Normalise each feed to { source, external_id, title, company, location, url, posted_at, description }.
export function normalise(kind, token, data) {
  if (kind === 'greenhouse') {
    return (data.jobs || []).map((j) => ({
      source: 'greenhouse', external_id: String(j.id), title: j.title, company: j.company_name || token,
      location: j.location?.name || '', url: j.absolute_url, posted_at: j.first_published || j.updated_at || null,
      description: strip(j.content),
    }));
  }
  if (kind === 'lever') {
    return (Array.isArray(data) ? data : []).map((j) => ({
      source: 'lever', external_id: j.id, title: j.text, company: token, location: j.categories?.location || '',
      workplace: j.workplaceType || '', url: j.hostedUrl, posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${strip(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n'),
    }));
  }
  if (kind === 'ashby') {
    return (data.jobs || []).map((j) => ({
      source: 'ashby', external_id: j.id, title: j.title, company: token, location: j.location || '',
      workplace: j.isRemote ? 'remote' : j.workplaceType || '', url: j.jobUrl || j.applyUrl, posted_at: j.publishedAt || null,
      description: j.descriptionPlain || strip(j.descriptionHtml),
    }));
  }
  return [];
}

// Keep jobs whose title matches a target role and whose location fits.
export function matches(job, client, now = Date.now()) {
  const title = job.title.toLowerCase();
  const roles = (client.target_titles || []).map((t) => t.toLowerCase());
  const titleHit = roles.some((r) => r.split(/\s+/).filter((w) => w.length > 2).every((w) => title.includes(w)));
  if (!titleHit) return false;
  const excluded = (client.excluded_keywords || []).some((k) => title.includes(k.toLowerCase()));
  if (excluded) return false;
  const loc = `${job.location} ${job.workplace || ''}`.toLowerCase();
  const remoteOk = client.remote !== 'onsite' && /remote|anywhere/.test(loc);
  const locHit = !client.locations?.length || client.locations.some((l) => loc.includes(l.toLowerCase())) || remoteOk;
  if (!locHit) return false;
  if (job.posted_at && client.max_age_days) {
    const age = (now - Date.parse(job.posted_at)) / 864e5;
    if (age > client.max_age_days) return false;
  }
  return true;
}

export async function fetchBoard(kind, token) {
  const res = await fetch(boardUrl(kind, token), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${kind}:${token} returned ${res.status}`);
  return normalise(kind, token, await res.json());
}
