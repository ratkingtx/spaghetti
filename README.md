# Spaghetti (HTML v2.3a, macOS) — Option D (Extremes labels), CST, Refresh — FIXED
This build fixes a template-literal quoting issue that caused a SyntaxError in Node.

## First run
```zsh
cd /Users/sehyunjou/Desktop/whatever
chmod +x run_spaghetti_html.command Refresh.command
./run_spaghetti_html.command
```

## Refresh
```zsh
./Refresh.command
```

### Defaults
TOP_N=50
INTERVAL=5m
HOURS=24
OUTDIR=out_spaghetti_html
LABEL_BASE_ONLY=true
TZ_NAME=America/Chicago
VOLUME_PERIOD=24h   # 24h|7d|30d

## Deploy to GitHub Pages
```zsh
./deploy_to_docs.command
# Commit and push are done automatically by the helper above if you run manually:
# git add docs deploy_to_docs.command
# git commit -m "deploy: update docs"
# git push origin main
```

Then in GitHub → Settings → Pages:
- Source: Deploy from a branch
- Branch: `main` / folder `docs`

Your site will be available at:
- https://ratkingtx.github.io/spaghetti/
