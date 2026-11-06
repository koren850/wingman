#!/bin/bash
# Wingman installer (macOS). Safe to run again; never uses sudo; never installs Node for you.
#
#   ./install.sh              check the machine, install dependencies, build Wingman.app, offer /Applications and the `wingman` command
#   ./install.sh --check      only report what is present and what is missing (changes nothing)
#   ./install.sh --dry-run    show every step that would run, change nothing
#   ./install.sh --yes        accept the default answer to every offer (copy to /Applications, `wingman` link, brew install ffmpeg);
#                         without a terminal and without --yes every offer is declined
#   ./install.sh --offline    pass --offline to pnpm (uses only the local package cache)
#   ./install.sh --update     git pull (fast-forward only), pnpm install --frozen-lockfile, rebuild the app   (also: wingman update)
#   ./install.sh --uninstall  remove the app copies and the `wingman` link; your data stays   (also: wingman uninstall)
#   ./install.sh --uninstall --purge   also delete your data and settings, after you type a confirmation
#                         (refuses a WINGMAN_DATA_DIR outside ~/Library/Application Support or without "Wingman" in its path, unless --force)
#
# Your data lives in ~/Library/Application Support/Wingman (calls, meetings); keys, settings and profile in ~/.config/wingman
# and the macOS Keychain. The installer only reads them, except for --uninstall --purge.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT/app"
APP_OUT="$APP_DIR/.app/Wingman.app"
APP_DST="${WINGMAN_APPS_DIR:-/Applications}/Wingman.app"
BIN_DIR="${WINGMAN_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/wingman"
FORCE=0
DATA_DIR="${WINGMAN_DATA_DIR:-$HOME/Library/Application Support/Wingman}"
CONFIG_DIR="$HOME/.config/wingman"

MODE=install; YES=0; DRY=0; PURGE=0; OFFLINE=0
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;; --dry-run) DRY=1 ;; --yes|-y) YES=1 ;; --offline) OFFLINE=1 ;;
    --update) MODE=update ;; --uninstall) MODE=uninstall ;; --purge) PURGE=1 ;; --force) FORCE=1 ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $a (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %sok%s    %s%s\n' "$G" "$N" "$([ "$DRY" = 1 ] && echo '[dry run] ')" "$1"; }
warn() { printf '  %swarn%s  %s\n' "$Y" "$N" "$1"; }
bad()  { printf '  %sMISSING%s %s\n' "$R" "$N" "$1"; }
say()  { printf '  %s\n' "$1"; }
FAILED=0; NO_FFMPEG=0
# run: does the command, or only prints it with --dry-run / --check.
run() { if [ "$DRY" = 1 ] || [ "$MODE" = check ]; then printf '  would run: %s\n' "$*"; return 0; fi; "$@"; }
# ask: yes/no question, default given ("y" or "n"). --yes takes the default; no terminal takes the default too. Prints nothing in --check.
ask() {
  local q="$1" def="$2" ans
  if [ "$MODE" = check ] || [ "$DRY" = 1 ]; then printf '  would ask: %s (default %s)\n' "$q" "$def"; [ "$def" = y ]; return; fi
  if [ "$YES" = 1 ]; then [ "$def" = y ]; return; fi
  if [ ! -t 0 ]; then return 1; fi   # no terminal and no --yes: every offer is declined
  read -r -p "  $q [$([ "$def" = y ] && echo Y/n || echo y/N)] " ans
  case "${ans:-$def}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
version_ge() { # version_ge 14.2.1 14.2
  local IFS=.; local -a a=($1) b=($2); local i
  for i in 0 1 2; do local x=${a[i]:-0} y=${b[i]:-0}; [ "$x" -gt "$y" ] && return 0; [ "$x" -lt "$y" ] && return 1; done; return 0
}
# Only THIS install's app counts (the /Applications copy or the one built in this folder), not any other Wingman on the machine.
running_app() { pgrep -f "$APP_DST/Contents/MacOS/Wingman" >/dev/null 2>&1 || pgrep -f "$APP_OUT/Contents/MacOS/Wingman" >/dev/null 2>&1; }
running_dst() { pgrep -f "$APP_DST/Contents/MacOS/Wingman" >/dev/null 2>&1; }
bundle_id() { /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null; }

# ---------------------------------------------------------------------------------------------------------------- uninstall
if [ "$MODE" = uninstall ]; then
  step "Uninstall Wingman"
  if running_app; then warn "Wingman is running: quit it from its menu-bar icon first, then run this again."; [ "$DRY" = 1 ] || exit 1; fi
  if [ -e "$APP_DST" ]; then
    if [ "$(bundle_id "$APP_DST")" = "com.wingman.app" ]; then run rm -rf "$APP_DST" && ok "removed $APP_DST"; else warn "$APP_DST is not Wingman (bundle id differs): left alone"; fi
  else say "no $APP_DST"; fi
  if [ -d "$APP_DIR/.app" ]; then run rm -rf "$APP_DIR/.app" && ok "removed $APP_DIR/.app"; else say "no built app in the repo"; fi
  # (a link made before the folder was renamed from stage0/ to app/ points into stage0/: remove that one too)
  if [ -L "$LINK" ] && [[ "$(readlink "$LINK")" == "$APP_DIR/"* || "$(readlink "$LINK")" == "$ROOT/stage0/"* ]]; then run rm -f "$LINK" && ok "removed $LINK"
  elif [ -e "$LINK" ]; then warn "$LINK is not a link into this folder: left alone"; else say "no $LINK"; fi
  if [ "$PURGE" = 1 ]; then
    step "Purge your data"
    say "This DELETES, for good:"
    say "  $DATA_DIR      (all calls, transcripts, summaries, prepared meetings, attachments)"
    say "  $CONFIG_DIR   (settings, profile, your pack, keys.env)"
    say "  the Wingman API keys in the macOS Keychain (service \"wingman\")"
    say "The old copy inside this repo folder (calls/ and data/private/ in app/, or in its former name stage0/), if you still have one, is NOT touched."
    # Safety check first (also in --dry-run, so it can be tested): both folders are resolved with `cd -P` (symlinks followed) before anything
    # is judged, and a path containing ".." is refused outright, even with --force.
    purge_refuse() { echo "install.sh: refusing to delete $1: $2" >&2; exit 1; }
    resolve_dir() { if [ -d "$1" ]; then (cd -P "$1" 2>/dev/null && pwd -P) || return 1; else printf '%s\n' "$1"; fi; }
    for d in "$DATA_DIR" "$CONFIG_DIR"; do
      case "$d" in *..*) purge_refuse "$d" "the path contains \"..\"." ;; esac
    done
    REAL_HOME="$(resolve_dir "$HOME")" || purge_refuse "$HOME" "cannot resolve the home folder."
    REAL_DATA="$(resolve_dir "$DATA_DIR")" || purge_refuse "$DATA_DIR" "cannot resolve the path."
    REAL_CONFIG="$(resolve_dir "$CONFIG_DIR")" || purge_refuse "$CONFIG_DIR" "cannot resolve the path."
    for d in "$REAL_DATA" "$REAL_CONFIG"; do
      case "$d" in ""|/|"$HOME"|"$HOME/"|"$REAL_HOME"|"$REAL_HOME/") purge_refuse "$d" "that is the home or root folder." ;; esac
    done
    # WINGMAN_DATA_DIR can point anywhere. Unless --force is given, only delete a folder under ~/Library/Application Support whose path contains "Wingman".
    if [ "$FORCE" != 1 ]; then
      case "$REAL_DATA" in "$REAL_HOME/Library/Application Support/"*Wingman*) ;; *) purge_refuse "$DATA_DIR" "it is not a Wingman folder under ~/Library/Application Support. Add --force if you really mean it." ;; esac
    fi
    if [ "$DRY" = 1 ]; then say "would ask you to type DELETE"; else
      if [ ! -t 0 ]; then echo "install.sh: --purge needs a terminal to confirm." >&2; exit 1; fi
      read -r -p "  Type DELETE to continue, anything else cancels: " c
      if [ "$c" = "DELETE" ]; then
        rm -rf "$REAL_DATA" "$REAL_CONFIG" && ok "removed $REAL_DATA and $REAL_CONFIG"
        for acct in DEEPGRAM_API_KEY ANTHROPIC_API_KEY; do security delete-generic-password -s wingman -a "$acct" >/dev/null 2>&1 && ok "removed Keychain item $acct" || say "no Keychain item $acct"; done
      else say "cancelled: nothing was deleted."; fi
    fi
  else
    say "Your data was NOT deleted. To delete it as well: ./install.sh --uninstall --purge"
    say "  data:      $DATA_DIR"
    say "  settings:  $CONFIG_DIR"
  fi
  step "By hand (macOS keeps these outside any folder)"
  say "Keychain keys:   open Keychain Access, search \"wingman\", delete the two items; or run:"
  say "                   security delete-generic-password -s wingman -a DEEPGRAM_API_KEY"
  say "                   security delete-generic-password -s wingman -a ANTHROPIC_API_KEY"
  say "Permissions:     System Settings > Privacy & Security > Microphone, and Screen & System Audio Recording:"
  say "                 select Wingman and press the minus button. Or: tccutil reset Microphone com.wingman.app"
  say "This repo folder: delete it yourself when you no longer want Wingman ($ROOT)."
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------- update
if [ "$MODE" = update ]; then
  step "Update Wingman"
  command -v git >/dev/null || { bad "git"; exit 1; }
  if [ ! -d "$ROOT/.git" ]; then bad "this folder is not a git checkout, so it cannot update itself. Download the newest version instead."; exit 1; fi
  if running_app; then warn "Wingman is running. Quit it after the update and open it again (it keeps running the old code until then)."; fi
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then warn "you have local changes; pull may refuse. Commit or stash them first."; fi
  before="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
  run git -C "$ROOT" pull --ff-only || { echo "install.sh: git pull failed (see above). Nothing else was changed." >&2; exit 1; }
  after="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"
  [ "$before" = "$after" ] && ok "already up to date ($after)" || ok "updated $before -> $after"
  MODE=install; UPDATING=1
fi

# ---------------------------------------------------------------------------------------------------------------- install / check
[ "$MODE" = check ] && step "Checking this Mac (nothing is changed)" || step "Checking this Mac"

[ -d "$APP_DIR" ] && [ -f "$APP_DIR/package.json" ] || { bad "app/package.json not found next to install.sh. Run it from a complete Wingman folder."; exit 1; }

# macOS and CPU
if [ "$(uname -s)" != Darwin ]; then bad "Wingman runs on macOS only (found $(uname -s))."; exit 1; fi
MACOS="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if version_ge "$MACOS" 14.2; then ok "macOS $MACOS (14.2 or newer needed for system audio)"; else bad "macOS $MACOS is too old: Wingman needs 14.2 or newer"; FAILED=1; fi
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ok "CPU: Apple silicon ($ARCH)" ;;
  x86_64) if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then warn "this shell runs under Rosetta. Use a native (arm64) Terminal and Node for best results."; else ok "CPU: Intel ($ARCH)"; fi ;;
  *) warn "unusual CPU: $ARCH" ;;
esac

# Node 24
if command -v node >/dev/null 2>&1; then
  NV="$(node -p 'process.versions.node' 2>/dev/null)"
  if [ "${NV%%.*}" -ge 24 ] 2>/dev/null; then ok "Node $NV"; else
    bad "Node $NV is too old: Wingman needs Node 24 or newer"; FAILED=1
    say "  install it yourself (this script does not install Node):"
    command -v brew >/dev/null && say "    brew install node@24     (then: brew link --overwrite node@24)"
    say "    or nvm: nvm install 24 && nvm use 24     (https://github.com/nvm-sh/nvm)"
    say "    or download from https://nodejs.org"
  fi
else
  bad "Node is not installed (Wingman needs Node 24 or newer)"; FAILED=1
  command -v brew >/dev/null && say "  install it yourself:  brew install node@24" || say "  install Homebrew (https://brew.sh) then: brew install node@24 ; or nvm / https://nodejs.org"
fi
if [ "$FAILED" = 1 ]; then echo; echo "Fix the missing items above, then run ./install.sh again."; exit 1; fi

# pnpm (through corepack)
PNPM_WANT="$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$APP_DIR/package.json" 2>/dev/null)"
if command -v pnpm >/dev/null 2>&1 && [ "$(cd "$APP_DIR" && pnpm -v 2>/dev/null | cut -d. -f1)" = "${PNPM_WANT%%.*}" ]; then
  ok "pnpm $(cd "$APP_DIR" && pnpm -v)"
else
  warn "pnpm ${PNPM_WANT%%.*} not available yet: enabling it with corepack (comes with Node, no sudo)"
  if command -v corepack >/dev/null 2>&1; then
    if [ "$MODE" != check ] && [ "$DRY" != 1 ]; then
      corepack enable >/dev/null 2>&1 || { mkdir -p "$BIN_DIR" && corepack enable --install-directory "$BIN_DIR" >/dev/null 2>&1; }
      case ":$PATH:" in *":$BIN_DIR:"*) ;; *) export PATH="$BIN_DIR:$PATH" ;; esac
      (cd "$APP_DIR" && corepack prepare "pnpm@$PNPM_WANT" --activate >/dev/null 2>&1) || true
    else say "would run: corepack enable"; fi
    if [ "$MODE" != check ] && [ "$DRY" != 1 ]; then
      if command -v pnpm >/dev/null 2>&1 && (cd "$APP_DIR" && pnpm -v >/dev/null 2>&1); then ok "pnpm $(cd "$APP_DIR" && pnpm -v)"; else bad "could not enable pnpm. Try: corepack enable   or   npm install -g pnpm@$PNPM_WANT"; exit 1; fi
    fi
  else bad "corepack not found. Install pnpm yourself: npm install -g pnpm@$PNPM_WANT"; FAILED=1; fi
fi

# ffmpeg (required: microphone), pdftotext (optional)
# The app started from Finder only sees /opt/homebrew/bin, /usr/local/bin, /usr/bin and /bin (scripts/make-app.sh sets that PATH), so an ffmpeg
# that only your shell finds (MacPorts, mise, nix...) does not count.
APP_FFMPEG=""; for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do [ -x "$d/ffmpeg" ] && { APP_FFMPEG="$d/ffmpeg"; break; }; done
if [ -n "$APP_FFMPEG" ]; then ok "ffmpeg ($APP_FFMPEG)"; else
  if command -v ffmpeg >/dev/null 2>&1; then warn "ffmpeg is at $(command -v ffmpeg), but Wingman.app does not look there (it only sees /opt/homebrew/bin and /usr/local/bin). Installing it with Homebrew gives the app one it can find."; fi
  bad "ffmpeg (needed for the microphone)"
  if command -v brew >/dev/null 2>&1; then
    if ask "Install it now with: brew install ffmpeg ?" y; then run brew install ffmpeg || { warn "brew install ffmpeg failed; install it yourself later"; NO_FFMPEG=1; }
    else say "  later:  brew install ffmpeg"; NO_FFMPEG=1; fi
  else say "  install Homebrew (https://brew.sh) and run: brew install ffmpeg"; NO_FFMPEG=1; fi
fi
if command -v pdftotext >/dev/null 2>&1 || [ -x /opt/homebrew/bin/pdftotext ] || [ -x /usr/local/bin/pdftotext ]; then ok "pdftotext (PDF attachments to meetings work)"; else warn "pdftotext not found: optional, only needed to attach PDFs to a meeting.  brew install poppler"; fi
command -v git >/dev/null 2>&1 && ok "git" || warn "git not found: needed only for 'wingman update'"

if [ "$MODE" = check ]; then
  step "Install state"
  [ -d "$APP_DIR/node_modules/.pnpm" ] && ok "dependencies installed" || warn "dependencies not installed yet"
  (cd "$APP_DIR" && ./scripts/make-app.sh --check | sed 's/^/  /')
  [ -d "$APP_DST" ] && ok "$APP_DST present" || say "$APP_DST not installed"
  [ -L "$LINK" ] && ok "wingman command: $LINK" || say "no wingman command link ($LINK)"
  [ -d "$DATA_DIR" ] && ok "data folder: $DATA_DIR" || say "data folder not created yet: $DATA_DIR"
  [ "$FAILED" = 1 ] && { echo; echo "Some required items are missing (see above)."; exit 1; }
  exit 0
fi
[ "$FAILED" = 1 ] && { echo; echo "Fix the missing items above, then run ./install.sh again."; exit 1; }

# Dependencies + Electron + the app (app postinstall downloads Electron and builds .app/Wingman.app)
step "Installing dependencies and building the app (first time downloads about 250 MB)"
PNPM_ARGS=(install --frozen-lockfile); [ "$OFFLINE" = 1 ] && PNPM_ARGS+=(--offline)
if [ "$DRY" = 1 ]; then say "would run in app: pnpm ${PNPM_ARGS[*]}"; else
  (cd "$APP_DIR" && pnpm "${PNPM_ARGS[@]}") || { echo; echo "install.sh: pnpm install failed (see above). Fix the reason and run ./install.sh again; it is safe to repeat." >&2; exit 1; }
fi
if [ "$DRY" != 1 ]; then
  # pnpm only runs the postinstall build when it installs something, so a moved folder (or a new Electron) would keep the old app.
  # make-app.sh --stale says so (missing app, built for another folder, other Electron version); a current app is left alone: fast and idempotent.
  if [ "${UPDATING:-0}" = 1 ] || (cd "$APP_DIR" && ./scripts/make-app.sh --stale); then
    (cd "$APP_DIR" && ./scripts/make-app.sh) || { echo "install.sh: building the app failed (see above)." >&2; exit 1; }
  fi
  [ -x "$APP_OUT/Contents/MacOS/Wingman" ] && ok "built $APP_OUT" || { bad "the app was not built"; exit 1; }
else say "would build $APP_OUT"; fi

# /Applications
step "Wingman in your Applications folder"
INSTALLED_APP=0
if [ -d "$APP_DST" ] && [ "$(bundle_id "$APP_DST")" != "com.wingman.app" ]; then warn "$APP_DST exists and is not Wingman: left alone"
elif ask "Copy Wingman.app to /Applications (Launchpad, Spotlight, Dock)?" y; then
  if running_dst; then warn "Wingman is running from $APP_DST: quit it (menu-bar icon > Quit Wingman), then run ./install.sh again to refresh it."
  else run bash -c 'mkdir -p "$(dirname "$1")" && rm -rf "$1.new" && cp -R "$2" "$1.new" && { [ ! -e "$1" ] || mv "$1" "$1.old"; } && mv "$1.new" "$1" && rm -rf "$1.old"' _ "$APP_DST" "$APP_OUT" && { ok "installed $APP_DST"; INSTALLED_APP=1; }; fi
else say "skipped. Later:  cd app && pnpm run install-app"; fi
say "Note: the app starts from this folder ($ROOT). If you move or delete it, run ./install.sh again from the new place."

# wingman command
step "The wingman command"
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$APP_DIR/scripts/wingman-cli.sh" ]; then ok "$LINK already points here"
else
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then Q="Replace the existing $LINK with a link to this Wingman?"; else Q="Add a 'wingman' command ($LINK)?"; fi
  if ask "$Q" y; then run mkdir -p "$BIN_DIR" && run ln -sf "$APP_DIR/scripts/wingman-cli.sh" "$LINK" && ok "linked $LINK"; else say "skipped. Use:  app/scripts/wingman-cli.sh <command>"; fi
fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) [ -L "$LINK" ] && warn "$BIN_DIR is not on your PATH. Add this line to ~/.zshrc, then open a new Terminal:   export PATH=\"$BIN_DIR:\$PATH\"" ;; esac

step "Done"
[ "$NO_FFMPEG" = 1 ] && warn "ffmpeg is still missing: the microphone will not work until you run  brew install ffmpeg"
if [ "$INSTALLED_APP" = 1 ]; then say "Next: open Wingman from Spotlight or Launchpad. The first window walks you through your API keys,"; else say "Next: run  open \"$APP_OUT\"  to start Wingman. The first window walks you through your API keys,"; fi
say "your name, the microphone and the permissions. You need a Deepgram key and an Anthropic key (both paid, a few dollars an hour at most)."
say "Without the app: app/scripts/wingman.sh --open-window   (or  pnpm dashboard  inside app)."
say "Update later with:  wingman update     Uninstall with:  wingman uninstall"
exit 0
