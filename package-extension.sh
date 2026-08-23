#!/bin/bash
set -euo pipefail

# Build the Chrome Web Store upload package: only the files the extension
# actually ships, none of the repo scaffolding (edge functions, docs, CI).
#
# Usage: ./package-extension.sh          -> dist/whatsync-<version>.zip

cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])" 2>/dev/null \
  || node -e "console.log(require('./manifest.json').version)")
OUT="dist/whatsync-${VERSION}.zip"

FILES=(
  manifest.json
  background.js
  content.js
  content.css
  config.js
  supabase.js
  dashboard-bridge.js
  popup.html
  popup.js
  email-confirm.html
)

# Include any icon/image assets referenced by the manifest.
for dir in icons images assets; do
  [ -d "$dir" ] && FILES+=("$dir")
done

for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "Missing required file: $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$OUT"
zip -r "$OUT" "${FILES[@]}" -x '*.DS_Store' >/dev/null

echo "Packaged $OUT ($(du -h "$OUT" | cut -f1))"
echo "Upload at https://chrome.google.com/webstore/devconsole"
