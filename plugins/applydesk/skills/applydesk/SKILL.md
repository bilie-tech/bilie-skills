---
name: applydesk
description: Job-application desk for career-services teams. Use when asked to onboard a job-seeking client, run a client's LinkedIn job search during a sitting they attend, tailor and score CVs (Resume Worded), fill employer application forms for a person to submit, guide a client through Easy Apply jobs, or log applications to Pacten. Windows and macOS; works under Claude Code or Codex.
---

# ApplyDesk

> **Educational use.** ApplyDesk is published for education and research into
> assisted job-application workflows. Whoever runs it is responsible for following
> the terms of every site it touches (LinkedIn, employer sites, Resume Worded,
> Pacten) and the privacy law that covers their clients' data.

ApplyDesk helps one staff member (the **operator**) handle job applications for many
clients on one computer. It does the slow parts: CV tailoring, scoring, form
filling, logging. People do the parts that belong to them: signing in, submitting,
anything a site asks a human to confirm.

## Ground rules

1. **The client signs in to LinkedIn themselves**, during a **sitting**: a block of
   time when they are present, in person or on a screen share. ApplyDesk never sees,
   types or stores a client's LinkedIn password, and opens LinkedIn only inside a
   sitting for that client.
2. **A person clicks every final Submit.** ApplyDesk fills forms and stops on the
   last page. `page click` refuses submit buttons.
3. **Stop, don't work around.** On a CAPTCHA, security check, email code or anything
   a site wants a human for, return `blocked` and tell the person what to do. Never
   try to get past it.
4. **Never invent qualifications.** A tailored CV may only use what is in the
   client's master CV (`cv check` enforces this).

## How to run a command

Every step is one command. Run it with Node from this skill's folder:

```
node "<this skill folder>/scripts/applydesk.mjs" <command> [args]
```

On Windows use the same line in PowerShell (forward slashes work). Each command
prints **one JSON line**:

| status | meaning | what you do |
|---|---|---|
| `ok` | step done | go on to `next` if given |
| `fail` | the step went wrong | fix the input and retry once; if it fails again, escalate the model (see below) |
| `blocked` | a person is needed | tell the person the `reason` in plain words and wait. Never escalate, never retry on your own |

Run `help` for the full command list. Keep page reads small: prefer `page fields`
and `page read` over screenshots.

## First run on a machine

1. `doctor --fix`: installs packages and checks the browser, keychain and disk
   encryption. Fix anything it lists.
2. `setup --operator <name> --pacten-url <url>`
3. `setup --signin resume-worded`, then `setup --signin pacten`. The operator signs
   in to their own seats. Then `setup --check`.

## The flow for each client

**1. Onboard** (once): `client new` opens a form. Fill it in with the client and
upload their CV (.docx). Record consent.

**2. Sitting** (client present):
- `sitting start <client> --present`: opens the client's LinkedIn window. The first
  time, the client signs in themselves. Later sittings usually start signed in.
- `discover linkedin <client>`: runs their searches and saves each job, with its
  description and route: **Easy Apply** or **employer site**.
- If Easy Apply jobs already have CVs ready, go through them now (step 5).
- `sitting end` when the client leaves.

Other sources need no sitting: `discover ats` for Greenhouse/Lever/Ashby boards,
`discover links` for links the client sends.

**3. CVs** (any time, every job on both lists). Follow `references/cv-rules.md`:
- `cv brief <client> <job>`: write the tailored CV to the `write_to` path
- `cv check <client> <job>`: fix and rewrite until it passes
- `cv render <client> <job>`
- `rw scan <client> <job>`: aim for 90+ general, or 80+ with `--targeted`. Use the
  tips, write the next version, check, render and scan again. Watch `rw budget`.

**4. Employer sites** (no sitting, no LinkedIn). See `references/apply.md`:
- `apply start <client> <job>`: opens the employer form and fills what the profile
  answers
- Answer the `left` fields with `page fields|set|click|upload <client>`. Use
  `page click --text "Next"` between pages.
- `apply ready <client> <job>`: screenshot, then into the queue
- A person runs `queue open`, checks, ticks declarations, and clicks Submit
- `apply done <client> <job>` logs it

**5. Easy Apply** (in a sitting, guided):
- `easy next <client>` opens the next job and returns the CV file and answer sheet
- Tell the client exactly what to click; they submit
- `easy done <client> <job>` (or `--skipped "<why>"`), then `easy next` again until
  it says done

**6. Log**: `pacten <client> <job>` for each applied job. Every application is also
in `logs/applications.csv`.

`queue` shows what's waiting to be submitted now, and which clients have Easy
Apply jobs for their next sitting.

## Models

Haiku runs everything by default. If a step fails twice, hand that step to the
`worker-sonnet` agent; if Sonnet fails twice, to `worker-opus`. Never escalate a
`blocked` result. Give the next model the command, the JSON output and what you tried.

## References

- `references/linkedin.md`: sittings and what ApplyDesk does on LinkedIn
- `references/cv-rules.md`: how to tailor a CV
- `references/apply.md`: employer sites, ATS notes, Workday accounts
