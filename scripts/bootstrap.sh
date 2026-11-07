#!/usr/bin/env bash
# ApplyDesk setup for macOS:
#   curl -fsSL https://raw.githubusercontent.com/bilie-tech/bilie-skills/main/scripts/bootstrap.sh | bash
#
# Installs what is missing (Node.js via Homebrew, Claude Code), adds the
# bilie-skills marketplace, installs the applydesk plugin, runs its health check.
set -euo pipefail
step() { printf '\n==> %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

step 'Node.js (20 or newer)'
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  if have brew; then brew install node; else echo 'Install Node.js 20+ from https://nodejs.org, then run this again.'; exit 1; fi
fi
node --version

step 'Browser'
if [ ! -d '/Applications/Google Chrome.app' ] && [ ! -d '/Applications/Microsoft Edge.app' ]; then
  if have brew; then brew install --cask google-chrome; else echo 'Install Google Chrome, then run this again.'; exit 1; fi
fi

step 'Claude Code'
if ! have claude; then
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
claude --version

step 'ApplyDesk plugin'
claude plugin marketplace add bilie-tech/bilie-skills || claude plugin marketplace update bilie-skills
claude plugin install applydesk@bilie-skills

step 'Health check (installs packages on first run)'
cli=$(find "$HOME/.claude/plugins" -path '*skills/applydesk/scripts/applydesk.mjs' 2>/dev/null | head -1)
[ -n "$cli" ] || { echo 'Could not find the installed applydesk.mjs'; exit 1; }
node "$cli" doctor --fix || true

printf "\nDone. Run 'claude' and say: set up ApplyDesk on this machine.\nApplyDesk data lives in %s/ApplyDesk\n" "$HOME"
