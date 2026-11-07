// Generic form handling that works on any employer site (and Pacten): scan the
// visible fields into a compact list, fill the ones the client's profile
// answers, and hand the rest to the model by short field id. This is what lets
// Haiku finish an unfamiliar form without ever reading the whole page.

// Runs inside the page. Tags every field with data-ad-id and returns a compact
// descriptor per field (label, type, required, options, current value).
export function scanFieldsInPage() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') || el.type === 'file';
  };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const labelFor = (el) => {
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.innerText).join(' '));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return clean(lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend') && (el.type === 'radio' || el.type === 'checkbox')) return clean(fs.querySelector('legend').innerText);
    const wrap = el.closest('label, .field, .form-group, .application-question, [class*="field"], [class*="question"], li, div');
    if (wrap) {
      const t = clean(wrap.innerText);
      if (t && t.length < 160) return t;
    }
    return clean(el.placeholder || el.name || el.id);
  };
  const out = [];
  const seenGroups = new Set();
  let n = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
    if (!visible(el) || el.disabled) continue;
    if (type === 'radio' || type === 'checkbox') {
      const key = el.name ? `${type}:${el.name}` : null;
      if (type === 'radio' && key) {
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const group = [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
        const id = `f${++n}`;
        group.forEach((g) => g.setAttribute('data-ad-id', id));
        out.push({
          id, type: 'radio', label: labelFor(el), required: group.some((g) => g.required),
          options: group.map((g) => clean(g.labels?.[0]?.innerText || g.value)),
          value: clean(group.find((g) => g.checked)?.labels?.[0]?.innerText || ''),
        });
        continue;
      }
    }
    const id = `f${++n}`;
    el.setAttribute('data-ad-id', id);
    const f = { id, type, label: labelFor(el), required: el.required || el.getAttribute('aria-required') === 'true' };
    if (el.tagName === 'SELECT') f.options = [...el.options].map((o) => clean(o.text)).filter(Boolean).slice(0, 60);
    if (type === 'checkbox') f.value = el.checked ? 'checked' : '';
    else if (type === 'file') f.value = el.files && el.files.length ? el.files[0].name : '';
    else f.value = clean(el.value);
    out.push(f);
  }
  return out;
}

// Legal statements the candidate makes. Always ticked by a person.
export const ATTEST = /certify|attest|declare|acknowledge|true and (complete|accurate)|terms and conditions/i;

const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose)|choose not/i;

// label regex -> how to answer from the client profile. Order matters: first match wins.
export const RULES = [
  { re: /resume|cv\b|curriculum/i, kind: 'file', from: (c, ctx) => ctx.cvFile },
  { re: /cover letter/i, kind: 'file', from: (c, ctx) => ctx.coverLetterFile || null },
  { re: /first\s*name|given name|forename/i, from: (c) => c.first_name },
  { re: /last\s*name|surname|family name/i, from: (c) => c.last_name },
  { re: /preferred name/i, from: (c) => c.preferred_name || c.first_name },
  { re: /full name|^name\b|your name/i, from: (c) => c.full_name },
  { re: /e-?mail/i, from: (c) => c.email },
  { re: /phone|mobile|telephone/i, from: (c) => c.phone },
  { re: /linkedin/i, from: (c) => c.linkedin_url },
  { re: /website|portfolio|github|personal (site|url)/i, from: (c) => c.website || null },
  { re: /current (company|employer)/i, from: (c) => c.current_company || null },
  { re: /current (title|position|role)|job title/i, from: (c) => c.current_title || null },
  { re: /\bcity\b/i, from: (c) => c.city },
  { re: /province|state\b|region/i, from: (c) => c.region || null },
  { re: /country/i, from: (c) => c.country },
  { re: /postal|zip/i, from: (c) => c.postal_code || null },
  { re: /location|where are you (based|located)|address/i, from: (c) => [c.city, c.region, c.country].filter(Boolean).join(', ') },
  { re: /sponsor/i, from: (c) => yesNo(c.needs_sponsorship) },
  { re: /(legally )?(authori[sz]ed|eligible|right) to work|work (authori[sz]ation|permit)/i, from: (c) => yesNo(c.work_authorized) },
  { re: /relocat/i, from: (c) => yesNo(c.willing_to_relocate) },
  { re: /notice period|start date|when can you start|availability/i, from: (c) => c.availability || null },
  { re: /salary|compensation|pay expectation|desired pay/i, from: (c) => c.salary_answer || null },
  { re: /hear about|how did you find|source/i, from: (c) => c.source_answer || 'LinkedIn' },
  { re: /gender|sex\b|race|ethnic|hispanic|latino|veteran|disabilit|sexual orientation|pronoun|transgender/i, kind: 'eeo' },
  { re: /privacy|consent to (the )?(processing|storage)|data (policy|processing)/i, kind: 'consent' },
  { re: ATTEST, kind: 'attest' },
];

function yesNo(v) {
  if (v === true || v === 'yes') return 'Yes';
  if (v === false || v === 'no') return 'No';
  return null;
}

function bestOption(options, wanted) {
  if (!options || !wanted) return null;
  const w = String(wanted).toLowerCase();
  return (
    options.find((o) => o.toLowerCase() === w) ||
    options.find((o) => o.toLowerCase().startsWith(w)) ||
    options.find((o) => o.toLowerCase().includes(w)) ||
    null
  );
}

// Decide an answer for each field. Pure: returns plan + what's left for the model/operator.
export function planFill(fields, client, ctx = {}) {
  const plan = [];
  const left = [];
  for (const f of fields) {
    if (f.value && f.type !== 'file') continue; // already filled (e.g. prefilled by the ATS)
    const rule = RULES.find((r) => r.re.test(f.label));
    if (!rule) {
      if (f.required) left.push({ ...f, why: 'unknown question' });
      continue;
    }
    if (rule.kind === 'eeo') {
      const answer = client.eeo_answers?.[eeoKey(f.label)] || 'decline';
      const opt = answer === 'decline' ? (f.options || []).find((o) => DECLINE.test(o)) : bestOption(f.options, answer);
      if (opt) plan.push({ id: f.id, type: f.type, value: opt, rule: 'eeo' });
      else if (f.required) left.push({ ...f, why: 'diversity question with no decline option — operator decides' });
      continue;
    }
    if (rule.kind === 'consent') {
      if (f.type === 'checkbox' && client.consent?.privacy_notices) plan.push({ id: f.id, type: 'checkbox', value: 'checked', rule: 'consent' });
      else if (f.required) left.push({ ...f, why: 'privacy consent — operator confirms' });
      continue;
    }
    if (rule.kind === 'attest') {
      // Legal statements are always the operator's click, never the agent's.
      if (f.required) left.push({ ...f, why: 'attestation — operator must tick this' });
      continue;
    }
    const value = rule.from(client, ctx);
    if (value === null || value === undefined || value === '') {
      if (f.required) left.push({ ...f, why: 'no answer in client profile' });
      continue;
    }
    if (rule.kind === 'file') {
      if (f.type === 'file') plan.push({ id: f.id, type: 'file', value, rule: 'file' });
      continue;
    }
    if (f.type === 'select-one' || f.type === 'radio' || f.options) {
      const opt = bestOption(f.options, value);
      if (opt) plan.push({ id: f.id, type: f.type, value: opt, rule: rule.re.source });
      else if (f.required) left.push({ ...f, why: `no option matches "${value}"` });
      continue;
    }
    if (f.type === 'file') continue;
    plan.push({ id: f.id, type: f.type, value: String(value), rule: rule.re.source });
  }
  return { plan, left };
}

function eeoKey(label) {
  if (/gender|sex\b|pronoun|transgender/i.test(label)) return 'gender';
  if (/race|ethnic|hispanic|latino/i.test(label)) return 'ethnicity';
  if (/veteran/i.test(label)) return 'veteran';
  if (/disabilit/i.test(label)) return 'disability';
  return 'other';
}

// Apply one planned value to the field with data-ad-id=id.
export async function setField(page, id, value, type) {
  const loc = page.locator(`[data-ad-id="${id}"]`);
  const count = await loc.count();
  if (!count) throw new Error(`Field ${id} not found; run "page fields" again (the form may have changed)`);
  const first = loc.first();
  const t = type || (await first.evaluate((el) => (el.type || el.tagName).toLowerCase()));
  if (t === 'file') return first.setInputFiles(value);
  if (t === 'select-one' || t === 'select') return first.selectOption({ label: value }).catch(() => first.selectOption(value));
  if (t === 'checkbox') return value === 'checked' || value === true ? first.check() : first.uncheck();
  if (t === 'radio') {
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      const label = await el.evaluate((e) => (e.labels?.[0]?.innerText || e.value || '').trim());
      if (label.toLowerCase() === String(value).toLowerCase() || label.toLowerCase().includes(String(value).toLowerCase())) return el.check();
    }
    throw new Error(`No radio option "${value}" for ${id}`);
  }
  await first.fill(String(value));
  // Autocomplete widgets (Greenhouse location, Workday dropdowns) need a pick.
  const listbox = page.locator('[role="listbox"] [role="option"]').first();
  if (await listbox.isVisible({ timeout: 800 }).catch(() => false)) await listbox.click().catch(() => {});
}

// The client's standard answers, for the person doing an Easy Apply by hand.
export function answerSheet(client) {
  const yn = (v) => yesNo(v) || '';
  return {
    name: client.full_name, email: client.email, phone: client.phone,
    location: [client.city, client.region, client.country].filter(Boolean).join(', '),
    linkedin: client.linkedin_url, website: client.website || '',
    authorised_to_work: yn(client.work_authorized), needs_sponsorship: yn(client.needs_sponsorship),
    willing_to_relocate: yn(client.willing_to_relocate), availability: client.availability || '',
    salary: client.salary_answer || '', diversity_questions: 'Prefer not to say, unless the client chose otherwise',
  };
}

export async function scan(page) {
  return page.evaluate(scanFieldsInPage);
}

// Clicks the agent may never make. Submitting is the operator's job.
export const SUBMIT_TEXT = /^(submit|apply|send|finish|complete|confirm)\b|submit application|send application|apply now|apply for this job/i;
