#!/bin/bash
# `wingman <command>`: command line for Wingman (run `wingman help`). Works through a symlink (resolves its own location).
# Runs src/cli/index.ts with the repo's tsx; the CLI talks to the running app over the owner-only control socket (tray/control-socket.cjs).
src="${BASH_SOURCE[0]}"
# follow symlinks by hand (macOS readlink has no -f); a relative link target is relative to the link's folder
while [ -L "$src" ]; do d="$(cd -P "$(dirname "$src")" && pwd)"; src="$(readlink "$src")"; [[ "$src" != /* ]] && src="$d/$src"; done
cd -P "$(dirname "$src")/.." || exit 1
exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
