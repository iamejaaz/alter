#!/usr/bin/env bash
# Install Alter as an always-on background service so scheduled routines
# keep running even after you quit the app. macOS only.
set -euo pipefail

APP="${1:-/Applications/Alter.app}"
BIN="$APP/Contents/MacOS/Alter"
LABEL="com.ejaaz.alter"
PLIST_SRC="$(dirname "$0")/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -x "$BIN" ]; then
  echo "Could not find the Alter binary at: $BIN"
  echo "Build the app first (npm run tauri build) and move Alter.app to /Applications,"
  echo "or pass the path: ./install-service.sh /path/to/Alter.app"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__APP_BINARY__|$BIN|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Installed. Alter will start at login and stay running in the background."
echo "Routines now fire even when the window is closed or you quit the app."
echo "To remove: ./uninstall-service.sh"
