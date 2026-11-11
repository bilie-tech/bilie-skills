// Every command ends by printing one JSON object on stdout. The model reads
// that object; humans get a short line on stderr. Keep results small: the
// cheaper the result, the cheaper every step on Haiku.
import { VERSION } from './config.mjs';

export function result(status, step, data = {}) {
  // Every line says which ApplyDesk ran, so a stale copy is easy to spot.
  const r = { ...data, status, step, v: VERSION }; // data can never overwrite status
  process.stdout.write(JSON.stringify(r) + '\n');
  return r;
}

export function say(msg) {
  process.stderr.write(`${msg}\n`);
}

export const ok = (step, data) => result('ok', step, data);
export const fail = (step, reason, data) => result('fail', step, { reason, ...data });
// blocked = needs a person (CAPTCHA, code, sign-in, missing data). Never escalate a model on blocked.
export const blocked = (step, reason, data) => result('blocked', step, { reason, ...data });
