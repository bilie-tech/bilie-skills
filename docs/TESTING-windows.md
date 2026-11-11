# ApplyDesk: Windows test checklist

For the person testing on a Windows 10/11 laptop. Takes about 45 minutes. Send
back the JSON line each step prints (the line starting with `{"status"`), or a
screenshot when something looks wrong.

You need: a Windows account you normally sign in to, internet access, a test
client who can join for the LinkedIn part (it can be you, with your own
LinkedIn), and a sample CV as a .docx.

## 1. Install (10 min)

1. Open **PowerShell** (Start → type "PowerShell").
2. Paste and press Enter:
   ```powershell
   irm https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/scripts/bootstrap.ps1 | iex
   ```
3. Approve any install prompts (Node.js, Git, Chrome, Claude Code).
4. At the end it runs a health check. **Send the OK/FAIL lines.** Expected:
   everything OK. If "disk encryption" fails, turn on Device encryption or
   BitLocker (Settings → Privacy & security → Device encryption) and re-run.
5. Close PowerShell, open a new one, run `claude` and sign in.

## 2. Operator setup (5 min)

In Claude, say: **"Set up ApplyDesk on this machine. My name is <your name>."**
- It should run `doctor`, then `setup --operator`.
- When it opens a window for Resume Worded, sign in to the company seat yourself.
- Check: `setup --check` says Resume Worded is signed in.

## 3. Onboard a test client (5 min)

Say: **"Onboard a new client."**
- A form opens in the browser, and Claude also gives you its address. Fill in a
  few fields, close the tab, then say "open the form again": what you typed should
  come back. Upload the CV (.docx or PDF), tick the consents, and click Save.
- Check: say "is it saved?". Claude lists what is still missing.
- Try "set Jane's city to San Diego": one field changes without the form.

## 4. Sitting and LinkedIn search (10 min, client present)

Say: **"Start a sitting for <client id>. They're here."**
- A Chrome window opens on LinkedIn. **The client types their own email and
  password.** Claude should never ask for them.
- Then say: **"Find jobs for them."**
- Check: it reports how many jobs it found, split into Easy Apply and employer site.
- Note anything LinkedIn shows (security check, warning). ApplyDesk should stop
  if it sees one; tell us exactly what it said.

## 5. CVs (10 min)

Say: **"Tailor CVs for the 2 newest employer-site jobs and score them."**
- Check: each job gets a CV, a local check result and a Resume Worded score.
- Open one CV (.docx) and check nothing is invented.

## 6. Employer-site form (5 min)

Say: **"Fill the application for the best one, but don't submit."**
- Check: the form fills in, the CV is attached, and it stops before Submit.
- **Do not click Submit** on a real job unless the client wants it.

## 7. Easy Apply, guided (5 min, client present)

If any Easy Apply job has a CV ready, say: **"Do the Easy Apply jobs with them."**
- Check: it opens the job and shows which CV to attach and the answers. The client
  clicks through. It moves to the next one when told it's done or skipped.

## 8. End the sitting

Say: **"End the sitting."** The LinkedIn window closes. Then start a new sitting
for the same client. **Check: it opens already signed in, with no password asked.**

## What to send back

- The JSON lines from each step (or say "ok" when it all matched)
- Windows version (Settings → System → About)
- Anything that took a long time, was confusing, or asked you for something unexpected
