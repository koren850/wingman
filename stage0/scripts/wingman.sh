#!/bin/bash
# Starts the Wingman app from the renamed runtime (.app built by make-app.sh), so macOS shows "Wingman", not "Electron".
# Menu bar only by default (`pnpm tray`); `pnpm dashboard` passes --open-window to open the main window too.
# It runs tray/main.cjs directly, so the launcher inside the .app (which adds --open-window itself) is not used here.
cd "$(dirname "$0")/.."
[ -x .app/Wingman.app/Contents/MacOS/Wingman ] || ./scripts/make-app.sh >/dev/null
exec .app/Wingman.app/Contents/MacOS/Wingman tray/main.cjs "$@"
