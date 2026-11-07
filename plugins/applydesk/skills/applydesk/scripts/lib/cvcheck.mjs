// Deterministic CV checker: runs on every tailored CV before Resume Worded sees
// it. Modelled on Resume Worded's published check groups (impact, brevity,
// style, ATS readability) plus two rules of our own: job-keyword coverage, and
// the trace rule — no skill may appear in the tailored CV unless it is in the
// master CV, because the process forbids inventing qualifications.

const WEAK_OPENERS = [
  'assisted', 'helped', 'worked on', 'responsible for', 'participated', 'involved in', 'tasked with',
  'duties included', 'handled', 'supported', 'contributed to', 'was part of',
];
const BUZZWORDS = [
  'team player', 'hard worker', 'hardworking', 'go-getter', 'detail-oriented', 'detail oriented', 'self-starter',
  'results-driven', 'results driven', 'synergy', 'think outside the box', 'dynamic', 'passionate', 'motivated',
  'best of breed', 'proven track record', 'strategic thinker', 'excellent communication skills', 'fast learner',
];
const FILLER = ['very', 'really', 'various', 'several', 'successfully', 'effectively', 'basically', 'actually'];
const PRONOUNS = /\b(i|me|my|mine|we|our|us)\b/i;
const PASSIVE = /\b(was|were|been|being|is|are)\s+(\w+ed|built|done|made|led|run|given|taken|written|seen)\b/i;
const NUMBER = /(\d|%|\$|£|€|₦|\bone\b|\btwo\b|\bthree\b|\bfour\b|\bfive\b|\bten\b|\bdozens?\b|\bhundreds?\b|\bthousands?\b|\bmillions?\b)/i;
const SECTIONS = {
  experience: /^(#+\s*)?(professional\s+|work\s+)?experience|employment(\s+history)?$/im,
  education: /^(#+\s*)?education/im,
  skills: /^(#+\s*)?(technical\s+|core\s+|key\s+)?skills|competencies/im,
};
const STOP = new Set(
  ('a an and are as at be by for from has have in is it its of on or that the to was were will with you your our we they this ' +
    'their who what when where which while about across all also any can do etc more most must new not other over per such than ' +
    'them then there these those through under up use using very well work working years year experience role team teams ability ' +
    'strong excellent including include includes job candidate candidates position company preferred required requirements ' +
    'responsibilities responsible plus related based within level knowledge skills skill understanding environment highly ' +
    'opportunity looking join help make ensure support provide across day days week weeks part full time like may might should')
    .split(/\s+/),
);

export function bullets(md) {
  return md
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([-*•·]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*•·]|\d+\.)\s+/, '').trim());
}

export function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.\-/]*[a-z0-9+#]|[a-z]/g) || []);
}

// Candidate keywords from the job description: tool/skill-like tokens and
// two-word phrases that repeat or look technical. Cheap, and good enough to
// tell the tailoring model which words matter.
export function jdKeywords(jd, limit = 30) {
  const toks = words(jd).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const freq = new Map();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  for (let i = 0; i < toks.length - 1; i++) {
    const bg = `${toks[i]} ${toks[i + 1]}`;
    freq.set(bg, (freq.get(bg) || 0) + 0.75);
  }
  const techy = (w) => /[+#./]|\d/.test(w) || /^[A-Z][a-zA-Z]+[A-Z]/.test(w);
  return [...freq.entries()]
    .filter(([w, n]) => n >= 2 || techy(w))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w)
    .filter((w, i, arr) => !(w.includes(' ') && w.split(' ').every((p) => arr.indexOf(p) > -1 && arr.indexOf(p) < i)))
    .slice(0, limit);
}

const has = (text, kw) => new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(text);

export function checkCv({ tailored, master, jd = '', maxWords = 900 }) {
  const issues = [];
  const add = (severity, rule, detail, where) => issues.push({ severity, rule, detail, ...(where ? { where } : {}) });
  const bl = bullets(tailored);
  const text = tailored.toLowerCase();
  const wordCount = words(tailored).length;

  // Structure / ATS readability
  for (const [name, re] of Object.entries(SECTIONS)) if (!re.test(tailored)) add('high', 'section-missing', `No "${name}" section heading`);
  if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(tailored)) add('high', 'contact', 'No email address');
  if (!/(\+?\d[\d\s().-]{7,}\d)/.test(tailored)) add('medium', 'contact', 'No phone number');
  if (/\|.*\|.*\|/.test(tailored)) add('medium', 'ats-table', 'Looks like a table; ATS parsers often scramble tables');

  // Brevity
  if (wordCount > maxWords) add('medium', 'length', `${wordCount} words; aim for ${maxWords} or fewer (about 2 pages)`);
  if (wordCount < 250) add('medium', 'length', `${wordCount} words; too thin to rank well`);
  if (bl.length < 6) add('high', 'bullets', `${bl.length} bullet points; experience should be in bullets`);

  // Impact
  const quantified = bl.filter((b) => NUMBER.test(b)).length;
  const qRatio = bl.length ? quantified / bl.length : 0;
  if (qRatio < 0.5) add('high', 'quantify', `${quantified}/${bl.length} bullets have a number; aim for at least half`);
  bl.forEach((b, i) => {
    const lower = b.toLowerCase();
    const weak = WEAK_OPENERS.find((w) => lower.startsWith(w));
    if (weak) add('medium', 'weak-opener', `Starts with "${weak}"`, `bullet ${i + 1}`);
    const wc = words(b).length;
    if (wc > 35) add('low', 'long-bullet', `${wc} words`, `bullet ${i + 1}`);
    if (PRONOUNS.test(b)) add('medium', 'pronoun', 'Personal pronoun in a bullet', `bullet ${i + 1}`);
    if (PASSIVE.test(b)) add('low', 'passive', 'Passive voice', `bullet ${i + 1}`);
  });
  const openers = bl.map((b) => words(b)[0]).filter(Boolean);
  const repeats = openers.filter((w, i) => openers.indexOf(w) !== i);
  const overused = [...new Set(repeats)].filter((w) => openers.filter((o) => o === w).length > 2);
  if (overused.length) add('low', 'repetition', `Verbs used to open 3+ bullets: ${overused.join(', ')}`);

  // Style
  const buzz = BUZZWORDS.filter((b) => text.includes(b));
  if (buzz.length) add('medium', 'buzzwords', buzz.join(', '));
  const filler = FILLER.filter((f) => has(text, f));
  if (filler.length > 2) add('low', 'filler', filler.join(', '));

  // Job match + trace rule
  let coverage = null;
  const missing = [];
  const untraced = [];
  if (jd) {
    const kws = jdKeywords(jd);
    const hit = kws.filter((k) => has(tailored, k));
    coverage = kws.length ? hit.length / kws.length : 1;
    for (const k of kws) {
      if (!has(tailored, k) && has(master, k)) missing.push(k); // in master, not used: free win
      if (has(tailored, k) && !has(master, k)) untraced.push(k); // in tailored, not in master: possible invention
    }
    if (coverage < 0.6) add('high', 'keywords', `Covers ${Math.round(coverage * 100)}% of job keywords; aim for 60%+`);
    if (missing.length) add('medium', 'keywords-unused', `In master CV but not used: ${missing.slice(0, 12).join(', ')}`);
    if (untraced.length) add('high', 'trace', `Not found in master CV — remove unless the client confirms: ${untraced.join(', ')}`);
  }

  const weights = { high: 9, medium: 4, low: 1.5 };
  const penalty = issues.reduce((s, i) => s + weights[i.severity], 0);
  const score = Math.max(0, Math.round(100 - penalty));
  const blocking = issues.filter((i) => i.severity === 'high');
  return {
    score,
    pass: score >= 85 && blocking.length === 0,
    words: wordCount,
    bullets: bl.length,
    quantified: Math.round(qRatio * 100),
    keyword_coverage: coverage === null ? null : Math.round(coverage * 100),
    issues,
  };
}
