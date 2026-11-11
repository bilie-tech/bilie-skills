// Reading a LinkedIn job page without depending on LinkedIn's class names.
//
// LinkedIn renames its page elements often (the 2026 "search-results" layout
// broke every selector the first reader used). So the page side only collects
// raw signals that survive redesigns: the tab title, meta tags, the job's
// schema.org JSON-LD, the text under the "About the job" heading, the main
// text, and every control that mentions "apply". `parseJob` turns those into a
// job on the Node side, where it can be unit-tested against saved signals.
import { ageDays } from './linkedin.mjs';

// Runs inside the page. Must stay self-contained (it is serialised by Playwright).
export function jobSignalsInPage() {
  const tidy = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content') || '';
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').slice(0, 6);

  // The description sits under an "About the job" heading in every layout seen so far.
  let about = '';
  const heads = [...document.querySelectorAll('h1, h2, h3, h4, strong, span, div')]
    .filter((e) => e.children.length <= 2 && /^\s*about the job\s*$/i.test(e.innerText || ''))
    .slice(0, 3);
  for (const h of heads) {
    let box = h.parentElement;
    for (let i = 0; box && i < 6 && (box.innerText || '').length < 300; i++) box = box.parentElement;
    const t = tidy(box?.innerText);
    if (t.length > about.length) about = t;
  }

  const main = document.querySelector('main, [role=main]') || document.body;
  const controls = [...document.querySelectorAll('button, a, [role=button], [role=link]')]
    .map((e) => ({
      text: tidy(e.innerText).slice(0, 80),
      aria: tidy(e.getAttribute('aria-label')).slice(0, 120),
      href: e.getAttribute('href') || '',
    }))
    // Only real apply buttons: job cards elsewhere on the page also say "Easy Apply",
    // but their text starts with the job title.
    .filter((c) => /^(easy apply|apply)\b/i.test(c.text) || /^(easy apply|apply)\b/i.test(c.aria))
    .slice(0, 12);
  const companyLink = [...document.querySelectorAll('a[href*="/company/"]')].map((a) => tidy(a.innerText)).find((t) => t && t.length < 80) || '';

  return {
    url: location.href,
    doc_title: document.title || '',
    og_title: meta('og:title'),
    h1: tidy(document.querySelector('h1')?.innerText).slice(0, 200),
    company_link: companyLink,
    ld,
    about,
    main: tidy(main.innerText).slice(0, 15000),
    controls,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function htmlToText(html) {
  let s = String(html || '');
  // JSON-LD often carries the HTML escaped once more ("&lt;p&gt;").
  if (/&lt;\/?[a-z]/i.test(s)) s = s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
  return s
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
      return m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function jobPostingFromLd(blocks = []) {
  for (const raw of blocks) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const items = [].concat(data, data?.['@graph'] || []).flat();
    const jp = items.find((x) => x && /JobPosting/.test([].concat(x['@type']).join(' ')));
    if (jp) return jp;
  }
  return null;
}

function ldLocation(jp) {
  const loc = [].concat(jp?.jobLocation || [])[0];
  const a = loc?.address || {};
  const country = typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry;
  const parts = [a.addressLocality, a.addressRegion, country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return /TELECOMMUTE/i.test(jp?.jobLocationType || '') ? 'Remote' : '';
}

// "Data Analyst | Acme | LinkedIn", "(3) Data Analyst | Acme | LinkedIn",
// "Acme hiring Data Analyst in Toronto, ON | LinkedIn".
export function parseJobTitle(docTitle) {
  const t = String(docTitle || '').replace(/^\(\d+\)\s*/, '').trim();
  let m = t.match(/^(.+?) hiring (.+?)(?: in (.+?))? \| LinkedIn$/i);
  if (m) return { company: m[1].trim(), title: m[2].trim(), location: (m[3] || '').trim() };
  const parts = t.split(/\s+\|\s+/);
  if (parts.length >= 3 && /^linkedin$/i.test(parts[parts.length - 1])) return { title: parts[0].trim(), company: parts[1].trim(), location: '' };
  return { title: '', company: '', location: '' };
}

const STOP = /^(set alert for similar jobs|about the company|show more|show less|seniority level|people you can reach out to|more jobs|similar jobs|looking for talent\?|meet the hiring team|premium|job search smarter)/im;

function descriptionFromText(about, main) {
  for (const src of [about, main]) {
    const i = src.search(/about the job/i);
    if (i < 0) continue;
    let d = src.slice(i).replace(/^about the job\s*/i, '');
    const stop = d.search(STOP);
    if (stop > 200) d = d.slice(0, stop);
    d = d.trim();
    if (d.length >= 200) return d;
  }
  return '';
}

// The few lines between the title and "About the job": company, "Location · 3 days ago · 40 applicants".
function topCard(main, title) {
  const i = main.search(/about the job/i);
  const head = i > 0 ? main.slice(0, i) : main.slice(0, 1500);
  const at = title ? head.indexOf(title) : -1;
  return (at >= 0 ? head.slice(at + title.length) : head).slice(0, 1500);
}

function locationFromTop(top, company) {
  for (const line of top.split('\n')) {
    if (!line.includes('·')) continue;
    for (const seg of line.split('·').map((s) => s.trim())) {
      if (!seg || seg === company) continue;
      if (/ago|applicant|clicked|promoted|reposted|over \d+|response|actively/i.test(seg)) continue;
      return seg.slice(0, 120);
    }
  }
  return '';
}

const CLOSED = /no longer accepting applications|this job is no longer available|job (has )?expired/i;

// How the job is applied for. 'unknown' rather than a guess when the signals disagree or are missing.
export function applyRoute(controls = [], html = '') {
  const said = controls.map((c) => `${c.text} ${c.aria}`);
  const easyButton = said.some((s) => /easy apply/i.test(s));
  const external = controls.find((c) => /^https?:/i.test(c.href) && !/linkedin\.com/i.test(c.href) && /apply/i.test(`${c.text} ${c.aria}`));
  const companySite = said.some((s) => /company (web)?site|on company|external/i.test(s));
  const m = html.match(/"companyApplyUrl"\s*:\s*"(https?:[^"]+)"/) || html.match(/externalApply[^"]*?url=([^&"]+)/);
  let applyUrl = m ? m[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&') : external?.href || '';
  if (/^https?%3A/i.test(applyUrl)) applyUrl = decodeURIComponent(applyUrl);
  const offsite = /OffsiteApply/.test(html);
  const onsite = /(Complex|Simple)OnsiteApply/.test(html);
  const easy = easyButton || onsite;
  const employer = Boolean(applyUrl) || companySite || offsite;
  if (easy && !employer) return { route: 'easy_apply', apply_url: '' };
  if (employer && !easy) return { route: 'employer_site', apply_url: applyUrl };
  return { route: 'unknown', apply_url: applyUrl };
}

export function parseJob(sig, jid, html = '') {
  const jp = jobPostingFromLd(sig.ld);
  const fromTitle = parseJobTitle(sig.doc_title);
  const fromOg = parseJobTitle(sig.og_title);
  const title = (jp?.title || sig.h1 || fromTitle.title || fromOg.title || '').trim();
  const company = (jp?.hiringOrganization?.name || fromTitle.company || fromOg.company || sig.company_link || '').trim();
  const description = (jp?.description ? htmlToText(jp.description) : '') || descriptionFromText(sig.about || '', sig.main || '');
  const top = topCard(sig.main || '', title);
  const location = ldLocation(jp) || fromTitle.location || fromOg.location || locationFromTop(top, company);
  const age = ageDays(top);
  const posted_at = jp?.datePosted ? new Date(jp.datePosted).toISOString() : age === null ? null : new Date(Date.now() - age * 864e5).toISOString();
  const r = applyRoute(sig.controls, html);
  const missing = [!title && 'title', !company && 'company', description.length < 200 && 'description'].filter(Boolean);
  return {
    source: 'linkedin',
    external_id: String(jid),
    title,
    company,
    location,
    url: `https://www.linkedin.com/jobs/view/${jid}/`,
    apply_url: r.apply_url,
    route: r.route,
    easy_apply: r.route === 'easy_apply' ? true : r.route === 'employer_site' ? false : null,
    posted_at,
    posted_exact: Boolean(jp?.datePosted),
    closed: CLOSED.test(sig.main || ''),
    description,
    complete: missing.length === 0,
    missing,
  };
}
