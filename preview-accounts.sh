#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${ACCOUNT_PREVIEW_HOME:-$HOME/.account-preview-workbench}"
CONFIG_FILE="${ACCOUNT_PREVIEW_CONFIG:-$STATE_DIR/accounts.tsv}"
PROFILE_DIR="$STATE_DIR/profiles"
LAUNCHER_DIR="$STATE_DIR/launchers"

chrome_app() {
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    printf '%s\n' "Google Chrome"
    return
  fi

  if [[ -d "$HOME/Applications/Google Chrome.app" ]]; then
    printf '%s\n' "$HOME/Applications/Google Chrome.app"
    return
  fi

  printf '%s\n' "Google Chrome"
}

usage() {
  cat <<EOF
Multi Account Preview

Usage:
  $(basename "$0") init
  $(basename "$0") start [env-name|env-name/account-name]
  $(basename "$0") list
  $(basename "$0") make-launchers
  $(basename "$0") make-app
  $(basename "$0") dashboard
  $(basename "$0") app
  $(basename "$0") desktop
  $(basename "$0") preset-sample
  $(basename "$0") reset <env-name/account-name>

Config:
  $CONFIG_FILE

Format:
  enabled<TAB>env<TAB>account<TAB>page<TAB>url<TAB>x<TAB>y<TAB>width<TAB>height<TAB>profileKey
EOF
}

slugify() {
  local raw="$1"
  local ascii
  local hash

  ascii="$(printf '%s' "$raw" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  hash="$(printf '%s' "$raw" | shasum -a 1 | awk '{ print substr($1, 1, 8) }')"

  if [[ -z "$ascii" ]]; then
    printf 'suite-%s\n' "$hash"
  else
    printf '%s-%s\n' "$ascii" "$hash"
  fi
}

ensure_state() {
  mkdir -p "$STATE_DIR" "$PROFILE_DIR" "$LAUNCHER_DIR"
}

init_config() {
  ensure_state
  if [[ -f "$CONFIG_FILE" ]]; then
    echo "Config already exists: $CONFIG_FILE"
    return
  fi

  cat > "$CONFIG_FILE" <<'EOF'
# enabled	env	account	page	url	x	y	width	height	profileKey	userAgent	deviceScaleFactor	mobileEmulation
yes	测试环境	默认账号	移动端	https://m.example.com	40	80	375	812	测试环境:默认账号			yes
yes	测试环境	默认账号	后台	https://admin.example.com	500	80	1440	820	测试环境:默认账号			no
no	测试环境	默认账号	收银台	https://cashier.example.com	1980	80	1440	820	测试环境:默认账号			no
EOF
  echo "Created: $CONFIG_FILE"
}

sample_config() {
  cat <<'EOF'
# enabled	env	account	page	url	x	y	width	height	profileKey	userAgent	deviceScaleFactor	mobileEmulation
yes	生产示例	默认账号	移动端	https://m.example.com/easy/	40	80	375	812	生产示例:默认账号			yes
yes	生产示例	默认账号	后台	https://admin.example.com/manage/	500	80	1440	820	生产示例:默认账号			no
yes	生产示例	默认账号	收银台	https://cashier.example.com/	1980	80	1440	820	生产示例:默认账号			no
yes	测试示例	默认账号	移动端	https://test-m.example.com/easy/	40	940	375	812	测试示例:默认账号			yes
yes	测试示例	默认账号	后台	https://test-admin.example.com/manage/	500	940	1440	820	测试示例:默认账号			no
yes	本地示例	默认账号	移动端	http://localhost:3009/easy/	40	1800	375	812	本地示例:默认账号			yes
yes	本地示例	默认账号	后台	http://localhost:3000/manage/	500	1800	1440	820	本地示例:默认账号			no
EOF
}

write_sample_preset() {
  ensure_state
  if [[ -f "$CONFIG_FILE" ]]; then
    local backup="$CONFIG_FILE.backup.$(date +%Y%m%d%H%M%S)"
    cp "$CONFIG_FILE" "$backup"
    echo "Backed up current config: $backup"
  fi
  sample_config > "$CONFIG_FILE"
  echo "Wrote sample preset: $CONFIG_FILE"
}

read_accounts() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Config missing. Run: $(basename "$0") init" >&2
    exit 1
  fi

  awk -F '\t' '
    NF >= 10 && $1 !~ /^#/ && $1 != "" {
      print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7 "\t" $8 "\t" $9 "\t" $10
    }
    NF == 9 && $1 !~ /^#/ && $1 != "" {
      print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7 "\t" $8 "\t" $9 "\t" $2 ":" $3
    }
    NF == 8 && $1 !~ /^#/ && $1 != "" {
      print $1 "\t" $2 "\t默认账号\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7 "\t" $8 "\t" $2 ":默认账号"
    }
  ' "$CONFIG_FILE"
}

open_one() {
  local env="$1"
  local account="$2"
  local page="$3"
  local url="$4"
  local x="$5"
  local y="$6"
  local width="$7"
  local height="$8"
  local profile_key="$9"
  local slug
  slug="$(slugify "$profile_key")"

  mkdir -p "$PROFILE_DIR/$slug"

  open -na "$(chrome_app)" --args \
    --user-data-dir="$PROFILE_DIR/$slug" \
    --profile-directory="Default" \
    --no-first-run \
    --disable-default-browser-check \
    --new-window "$url" \
    --window-position="$x,$y" \
    --window-size="$width,$height"

  echo "Opened [$env / $account / $page] with shared account profile: $PROFILE_DIR/$slug"
}

start_accounts() {
  ensure_state
  local target="${1:-}"
  local matched=0

  while IFS=$'\t' read -r enabled env account page url x y width height profile_key; do
    [[ "$enabled" == "yes" ]] || continue
    if [[ -n "$target" && "$target" != "$env" && "$target" != "$env/$account" ]]; then
      continue
    fi

    matched=1
    open_one "$env" "$account" "$page" "$url" "$x" "$y" "$width" "$height" "$profile_key"
    sleep 0.4
  done < <(read_accounts)

  if [[ "$matched" -eq 0 ]]; then
    echo "No enabled environment/account matched: ${target:-all}" >&2
    exit 1
  fi
}

list_accounts() {
  ensure_state
  printf "%-10s %-18s %-12s %-12s %-8s %s\n" "enabled" "env" "account" "page" "profile" "url"
  while IFS=$'\t' read -r enabled env account page url _x _y _width _height profile_key; do
    local slug
    slug="$(slugify "$profile_key")"
    printf "%-10s %-18s %-12s %-12s %-8s %s\n" "$enabled" "$env" "$account" "$page" "$slug" "$url"
  done < <(read_accounts)
}

make_launchers() {
  ensure_state
  rm -f "$LAUNCHER_DIR"/*.command 2>/dev/null || true

  local seen_file
  seen_file="$(mktemp)"

  while IFS=$'\t' read -r enabled env account _page _url _x _y _width _height profile_key; do
    [[ "$enabled" == "yes" ]] || continue
    local key="$env/$account"
    if grep -Fxq "$key" "$seen_file"; then
      continue
    fi
    printf '%s\n' "$key" >> "$seen_file"

    local slug launcher
    slug="$(slugify "$profile_key")"
    launcher="$LAUNCHER_DIR/$slug.command"
    cat > "$launcher" <<EOF
#!/usr/bin/env bash
"$TOOL_DIR/preview-accounts.sh" start "$env/$account"
EOF
    chmod +x "$launcher"
    echo "Created launcher: $launcher"
  done < <(read_accounts)

  rm -f "$seen_file"
  echo "Open this folder in Finder: $LAUNCHER_DIR"
}

make_app() {
  ensure_state
  local app_path="$TOOL_DIR/Multi-Account-Preview.app"
  local macos_dir="$app_path/Contents/MacOS"
  local launcher_script="$macos_dir/Multi-Account-Preview"

  rm -rf "$app_path"
  mkdir -p "$macos_dir" "$app_path/Contents/Resources"

  cat > "$app_path/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>Multi-Account-Preview</string>
  <key>CFBundleIdentifier</key>
  <string>local.multi-account-preview</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Multi Account Preview</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.13</string>
</dict>
</plist>
EOF

  cat > "$launcher_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"
"$TOOL_DIR/preview-accounts.sh" desktop > "$STATE_DIR/desktop.log" 2>&1
EOF
  chmod +x "$launcher_script"

  echo "Created app launcher: $app_path"
  echo "Log file: $STATE_DIR/desktop.log"
}

open_dashboard() {
  open "$TOOL_DIR/account-preview-dashboard.html"
}

open_app() {
  node "$TOOL_DIR/account-preview-app.js" --open
}

open_desktop() {
  export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  local desktop_dir="$TOOL_DIR/desktop-shell"
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm command not found. Install Node.js, or make sure npm is available in /usr/local/bin or /opt/homebrew/bin." >&2
    exit 127
  fi
  if [[ ! -d "$desktop_dir/node_modules/electron" ]]; then
    echo "Installing Electron desktop shell dependencies..."
    (cd "$desktop_dir" && npm install)
  fi
  (cd "$desktop_dir" && npm start)
}

reset_account() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "Please provide an environment/account name, for example: 测试示例/账号1" >&2
    exit 1
  fi

  local found=0
  while IFS=$'\t' read -r _enabled env account _page _url _x _y _width _height profile_key; do
    [[ "$target" == "$env/$account" ]] || continue
    found=1
    local slug
    slug="$(slugify "$profile_key")"
    rm -rf "$PROFILE_DIR/$slug"
    echo "Removed profile for [$env / $account]: $PROFILE_DIR/$slug"
    break
  done < <(read_accounts)

  if [[ "$found" -eq 0 ]]; then
    echo "No environment/account matched: $target" >&2
    exit 1
  fi
}

main() {
  local command="${1:-}"
  shift || true

  case "$command" in
    init) init_config ;;
    start) start_accounts "${1:-}" ;;
    list) list_accounts ;;
    make-launchers) make_launchers ;;
    make-app) make_app ;;
    dashboard) open_dashboard ;;
    app) open_app ;;
    desktop) open_desktop ;;
    preset-sample) write_sample_preset ;;
    reset) reset_account "${1:-}" ;;
    ""|-h|--help|help) usage ;;
    *)
      echo "Unknown command: $command" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
