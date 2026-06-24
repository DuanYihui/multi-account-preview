#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/desktop-shell"
if [[ ! -d node_modules/electron ]]; then
  npm install
fi
npm start
