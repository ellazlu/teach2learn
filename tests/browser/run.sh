#!/usr/bin/env bash
# Drives the real UI + SessionEngine in headless Chromium with simulated
# microphone, text-to-speech and API. Usage: bash tests/browser/run.sh
# (first time: npx playwright install chromium)
set -euo pipefail
cd "$(dirname "$0")/../.."
ESBUILD="${ESBUILD:-npx esbuild}"
mkdir -p tests/browser/out
$ESBUILD tests/browser/harness.jsx --bundle --loader:.js=jsx --jsx=automatic --outfile=tests/browser/out/app.js --log-level=error
node tests/browser/run.mjs
node tests/browser/study.mjs
node tests/browser/daily.mjs
