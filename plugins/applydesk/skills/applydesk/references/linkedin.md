# LinkedIn: sittings

LinkedIn is where most jobs are found, and every LinkedIn account belongs to one
person. ApplyDesk only works in a client's LinkedIn while that client is present.

## What a sitting is

A sitting is a block of time, up to 3 hours, when the client is with the operator:
in the room, or on a screen share of the ApplyDesk computer.

- `sitting start <client> --present` opens that client's LinkedIn browser window.
  Only start it once the client is actually there.
- The first time, the client types their own email and password and approves any
  2-step check. ApplyDesk waits; it never sees or stores the password.
- The window keeps them signed in on this computer, so later sittings usually
  start signed in, with no prompts.
- Only one sitting is open on a computer at a time. `sitting end` closes the
  window when the client leaves. Sittings also end on their own after 3 hours.
- Every sitting start and end is logged to `logs/sittings.jsonl`.

## What ApplyDesk does in a sitting

- Runs the client's saved job searches (`discover linkedin`) and reads the job
  pages it finds.
- Saves each job's description and its route: Easy Apply, or the employer link.
- Opens Easy Apply jobs one at a time (`easy next`). The client clicks Easy Apply,
  attaches the CV, checks the answers and submits.

## What ApplyDesk never does on LinkedIn

- Open LinkedIn outside a sitting, or for a different client than the one present.
- Type or store a LinkedIn password, or copy sign-in cookies out of the browser.
  The guard hook blocks commands that try.
- Message, connect, follow, post, view people's profiles, or edit the client's profile.
- Click Easy Apply or Submit.
- Slow itself down, hide itself, or get past a check. If LinkedIn shows a security
  check, a CAPTCHA or a warning, ApplyDesk stops, ends the sitting and leaves the
  window for the client. Do not retry with ApplyDesk that day. The next sitting
  shows that it happened, so ask the client whether their account is fine.

## Risks to explain to the client

LinkedIn's User Agreement restricts automated tools, even on your own account.
LinkedIn may warn, limit or restrict an account it thinks is automated. The client
accepts this in the onboarding consent. They can stop it at any time: LinkedIn >
Settings > Sign out of all sessions, or the operator runs `sitting forget <client>`
to delete the saved sign-in on this computer.

## Keeping sign-ins safe

- Each client's sign-in lives in their own browser profile under
  `ApplyDesk/profiles/li-<client>`. Chrome encrypts it with this computer's key,
  so a copied folder doesn't work anywhere else.
- `doctor` requires disk encryption (BitLocker or FileVault) before any sitting.
- Staff work on employer sites uses a separate profile (`apply-<client>`) that
  holds no LinkedIn sign-in.
