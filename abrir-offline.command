#!/bin/sh
# ClaudeCAD offline (macOS / Linux): serves this folder on http://localhost:8765/ and opens it.
# Needs python3 (macOS installs it with the command line tools). Press Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1
URL="http://localhost:8765/"
( sleep 1; if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1; fi ) &
echo "ClaudeCAD: $URL  (Ctrl+C para parar)"
exec python3 -m http.server 8765 --bind 127.0.0.1
