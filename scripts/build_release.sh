#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release"

FILES=(
  "manifest.json"
  "background.js"
  "popup.html"
  "popup.js"
  "rules.json"
  "icon16.png"
  "icon48.png"
  "icon128.png"
  "README.md"
)

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

for file in "${FILES[@]}"; do
  cp "$ROOT_DIR/$file" "$RELEASE_DIR/$file"
done

echo "Release folder created at: $RELEASE_DIR"
echo "Included files:"
printf ' - %s\n' "${FILES[@]}"
