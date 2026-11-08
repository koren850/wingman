#!/bin/bash
# `wingman <command>`: command line for Wingman (run `wingman help`). Works through a symlink (resolves its own location).
# Runs src/cli/index.ts with the repo's tsx; the CLI talks to the running app over the user-only control socket (tray/control-socket.cjs).
src="${BASH_SOURCE[0]}"
# follow symlinks by hand (macOS readlink has no -f); a relative link target is relative to the link's folder
while [ -L "$src" ]; do d="$(cd -P "$(dirname "$src")" && pwd)"; src="$(readlink "$src")"; [[ "$src" != /* ]] && src="$d/$src"; done
cd -P "$(dirname "$src")/.." || exit 1
# `wingman update` and `wingman uninstall [--purge]` are handled by the installer at the repo root (they must work without node_modules).
case "${1:-}" in
  update) shift; exec ../install.sh --update "$@" ;;
  uninstall) shift; exec ../install.sh --uninstall "$@" ;;
esac
exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
