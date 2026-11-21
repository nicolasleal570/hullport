#!/bin/sh
# Double-click to open Hullport. Builds the app first if it isn't there yet.
cd "$(dirname "$0")" || exit 1
APP="target/release/bundle/macos/Hullport.app"
if [ ! -d "$APP" ]; then
  echo "Building Hullport (first time only, a few minutes)..."
  npm install && npm run tauri build || { echo "Build failed"; read -r _; exit 1; }
fi
open "$APP"
