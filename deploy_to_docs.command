#!/bin/zsh
set -e

export TOP_N=${TOP_N:-30}
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

if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

node build_html.js

rm -rf docs
mkdir -p docs
cp "$OUTDIR/spaghetti.html" docs/index.html
cp "$OUTDIR/plotly.min.js" docs/plotly.min.js
cp "$OUTDIR"/spaghetti_*.csv docs/ 2>/dev/null || true
touch docs/.nojekyll

echo "Docs prepared in ./docs (index.html). Push to GitHub and enable Pages (main /docs)."

