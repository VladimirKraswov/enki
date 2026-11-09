#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
owned_dir="$HOME/.local/share/enki"
plist="$HOME/Library/LaunchAgents/dev.vladimir.oc-helper-tunnel.plist"
mkdir -p "$owned_dir" "$HOME/Library/LaunchAgents"
install -m 700 "$source_dir/tunnel.sh" "$owned_dir/helper-tunnel.sh"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.vladimir.oc-helper-tunnel</string>
<key>ProgramArguments</key><array><string>$owned_dir/helper-tunnel.sh</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || :
launchctl bootstrap "gui/$(id -u)" "$plist"
