# Tailoring a CV

Input: the client's master CV (`master_md`) and the job description (`jd_md`), both
from `cv brief`. Output: one markdown file at `write_to`. Then run `cv check`.

## Hard rules

1. **Nothing new.** Every employer, title, date, degree, certificate, tool and skill
   must already be in the master CV. You may reword, reorder, cut and emphasise; you
   may not add. `cv check` flags any job keyword that appears in the tailored CV but
   not the master. If a job wants something the client lacks, leave it out.
2. Keep dates, employers and titles exactly as in the master.
3. Respect `considerations` from `cv brief` (career gaps, things not to mention).

## Shape

```
# Full Name
City, Region · phone · email · linkedin url

## Summary
2–3 lines aimed at this job, using its words where they are true.

## Skills
One or two lines, the job's matching skills first.

## Experience
### Title — Employer
Month Year – Month Year · City
- Action verb + what + result with a number
- ...

## Education
### Degree — School
Year
```

- One column, plain headings, no tables or images (ATS parsers break on them).
- 1 page for under 10 years' experience, otherwise 2 at most (about 900 words).
- 3–6 bullets for recent roles, 1–3 for older ones; drop roles older than 15
  years unless they matter for this job.

## Bullets

- Start with a strong past-tense verb (led, built, cut, grew, launched). Never
  "responsible for", "helped", "worked on".
- Put a number in most bullets (%, $, time, volume, team size), but only numbers
  that are in the master CV.
- No "I", "my" or "we". No buzzwords ("team player", "results-driven",
  "passionate"). No filler ("very", "various", "successfully").
- Use the job description's own words for skills the client really has.

## The loop

1. Write `cv-N.md`, then `cv check`. Fix every high and medium issue and write
   `cv-(N+1).md`. Don't edit an older version.
2. When it passes, `cv render`, then `rw scan`.
3. Below target? Apply the Resume Worded tips that don't break rule 1, write the next
   version, and check, render and scan again. Stop after 3 scans per job and note the best
   score; the monthly scan budget is shared by every client.
