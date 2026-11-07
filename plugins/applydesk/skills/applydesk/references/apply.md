# Employer-site applications

These need no sitting and never touch LinkedIn. The job's employer link was saved
when it was found. ApplyDesk uses the client's `apply-<client>` browser profile.

## Steps

1. `apply start <client> <job>`: opens the form, uploads the tailored CV and fills
   every field the client profile answers. Returns `left`: fields it could not answer.
2. For each `left` field:
   - Answer from the client profile or master CV when the answer is clearly there:
     `page set <client> <fieldId> <value>`.
   - Upload a cover letter with `page upload <client> <fieldId> <file>` if one was written.
   - If the answer isn't known (an unusual question, a declaration, a diversity question
     with no "prefer not to say"), leave it. The person reviewing will answer it.
3. Multi-page forms: `page click <client> --text "Next"` (or "Continue", "Save and
   continue"), then `page fields <client>` and fill again.
4. `apply ready <client> <job>`: checks required fields, takes a screenshot, and puts
   the job in the queue.
5. A person runs `queue open <client> <job>`, reads every field, ticks any
   declaration, and clicks Submit.
6. `apply done <client> <job>` records it, then `pacten <client> <job>`.

## Things that need a person (return blocked and say so)

| What | What the person does |
|---|---|
| CAPTCHA or "are you human" | Solves it in the open window |
| Email or SMS code | Gets the code from the client's inbox or phone and types it |
| Declarations ("I certify…") | Reads and ticks them |
| Questions the profile doesn't answer | Answers them, or asks the client |
| Final Submit | Clicks it |

## By system

- **Greenhouse, Lever, Ashby**: no account needed; usually one page. Some ask for a
  short answer to "why this company". Write it only from facts in the job description
  and master CV.
- **Workday**: one candidate account per employer. Make it with the client's email:
  `creds gen <client> <host>` creates and stores a password, and `creds fill <client>
  <host> <fieldId>` types it. Workday then emails a verification link; the person
  opens it. Its forms run 5–7 pages; parse the CV upload page carefully and correct
  any field it mis-filled.
- **iCIMS, Taleo/Oracle, SuccessFactors**: usually need an account and several pages.
  Treat like Workday.
- **Unknown sites**: `page fields` first. If the page has no form, look for an
  "Apply" link with `page read` and click it.

Never click Submit, Apply or Send on the last page. `page click` refuses them anyway.
