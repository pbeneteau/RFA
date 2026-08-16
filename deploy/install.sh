#!/bin/zsh
# Installs the RFA launchd agents (hub + supervisor) for the current user.
# NOT run automatically: stop any nohup'd hub/pm-agent first, then run this once.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p ~/Library/LaunchAgents
cp "$DIR"/com.rfa.hub.plist "$DIR"/com.rfa.supervisor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rfa.hub.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rfa.supervisor.plist
echo "installed. status: launchctl list | grep com.rfa"
echo "uninstall: launchctl bootout gui/$(id -u)/com.rfa.hub && launchctl bootout gui/$(id -u)/com.rfa.supervisor"
