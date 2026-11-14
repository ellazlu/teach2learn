#!/usr/bin/env bash
# Runs the real API route handlers with stand-ins for next/server and the
# Anthropic SDK (no network, no API key). Usage: bash tests/routes/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ESBUILD="${ESBUILD:-npx esbuild}"
for r in prepare evaluate speak feedback; do
  $ESBUILD app/api/$r/route.js --bundle --platform=node --format=esm \
    --alias:next/server=./tests/routes/next-server-stub.js \
    --alias:@anthropic-ai/sdk=./tests/routes/sdk-stub.js \
    --outfile=tests/routes/out/$r.mjs --log-level=error
done
$ESBUILD lib/student/knowledge.ts --bundle --platform=node --format=esm --outfile=tests/routes/out/knowledge.mjs --log-level=error
node tests/routes/check.mjs
