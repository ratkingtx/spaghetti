#!/bin/zsh
export TOP_N=${TOP_N:-50}
export INTERVAL=${INTERVAL:-5m}
export HOURS=${HOURS:-24}
export OUTDIR=${OUTDIR:-out_spaghetti_html}
export LABEL_BASE_ONLY=${LABEL_BASE_ONLY:-true}
export TZ_NAME=${TZ_NAME:-America/Chicago}

cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install from https://nodejs.org/ and re-run."
  exit 1
fi
node build_html.js
if command -v open >/dev/null 2>&1; then open "$OUTDIR/spaghetti.html" || true; fi
