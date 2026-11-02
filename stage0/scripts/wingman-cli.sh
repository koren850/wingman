#!/bin/bash
# `wingman <command>`: command line for Wingman (run `wingman help`). Works through a symlink (resolves its own location).
src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do d="$(cd -P "$(dirname "$src")" && pwd)"; src="$(readlink "$src")"; [[ "$src" != /* ]] && src="$d/$src"; done
cd -P "$(dirname "$src")/.." || exit 1
exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
