# bilie-skills

Public Claude Code plugins from Bilie Tech.

| Plugin | What it does |
|---|---|
| [applydesk](plugins/applydesk) | Job-application desk for career-services teams |

> **Educational use.** These plugins are published for education and research.
> Whoever runs them is responsible for following the terms of the sites they use
> and the privacy law that covers the people whose data they handle.

## Install

**Windows** (PowerShell, no admin needed). This installs Node.js, Git, Chrome and
Claude Code if they're missing, then the plugin:

```powershell
irm https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/scripts/bootstrap.ps1 | iex
```

**macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/scripts/bootstrap.sh | bash
```

**Already have Claude Code:**

```
claude plugin marketplace add bilie-tech/bilie-skills
claude plugin install applydesk@bilie-skills
```

Then start `claude` and say "set up ApplyDesk on this machine".

## ApplyDesk in one minute

One staff member (the operator) handles applications for many clients on one
computer.

1. **Onboard** each client once with a form: their details, standard answers, master
   CV and consent.
2. **Sitting:** with the client present (in person or on a screen share), the client
   signs in to LinkedIn themselves. ApplyDesk runs their job searches and splits the
   results into **Easy Apply** jobs and **employer-site** jobs. Later sittings
   usually start already signed in.
3. **CVs:** each job gets a tailored CV, checked against the master CV so nothing
   is invented, and scored on Resume Worded.
4. **Employer sites:** ApplyDesk fills the form and stops on the last page. A person
   checks it and clicks Submit. No LinkedIn and no client needed.
5. **Easy Apply:** in the client's sitting, ApplyDesk opens each job with the CV and
   answers ready; the client submits, then the next one opens.
6. **Logging:** every application goes to Pacten and to `ApplyDesk/logs/applications.csv`.

What it never does: type or store a client's LinkedIn password, open LinkedIn
when the client isn't there, click Submit, or get past a CAPTCHA or security
check. See [the skill](plugins/applydesk/skills/applydesk/SKILL.md) and
[the LinkedIn rules](plugins/applydesk/skills/applydesk/references/linkedin.md).

**Codex:** the skill is a standard `SKILL.md`, and every step is a plain Node
command. Copy `plugins/applydesk/skills/applydesk` into `~/.agents/skills/` and
`plugins/applydesk/codex/agents/*.toml` into `~/.codex/agents/`.

## Requirements

- Windows 10/11 or macOS, with disk encryption on (BitLocker / Device encryption,
  or FileVault). `doctor` checks this before any sign-in is kept.
- Google Chrome or Microsoft Edge
- Node.js 20+
- A Resume Worded seat and Pacten access for the operator

## Development

```
node --test "tests/*.test.mjs"                      # unit tests
APPLYDESK_E2E=1 node --test tests/e2e.test.mjs      # real browser, practice job site
```

CI runs both on Windows and macOS.
