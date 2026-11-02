#!/bin/bash
# Starts the Wingman app (menu bar + window) from the renamed runtime, so macOS shows "Wingman", not "Electron".
cd "$(dirname "$0")/.."
[ -x .app/Wingman.app/Contents/MacOS/Wingman ] || ./scripts/make-app.sh >/dev/null
exec .app/Wingman.app/Contents/MacOS/Wingman tray/main.cjs "$@"
