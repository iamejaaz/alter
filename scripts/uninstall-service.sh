#!/usr/bin/env bash
# Remove the Alter background service.
set -euo pipefail

LABEL="com.ejaaz.alter"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST_DST" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "Removed the Alter background service."
