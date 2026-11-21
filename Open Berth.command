#!/bin/sh
# Double-click to open Berth. Builds the app first if it isn't there yet.
cd "$(dirname "$0")" || exit 1
APP="target/release/bundle/macos/Berth.app"
if [ ! -d "$APP" ]; then
  echo "Building Berth (first time only, a few minutes)..."
  npm install && npm run tauri build || { echo "Build failed"; read -r _; exit 1; }
fi
open "$APP"
