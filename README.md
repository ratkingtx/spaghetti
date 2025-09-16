# Spaghetti (HTML v2.3a, macOS) — Option D (Extremes labels), CST, Refresh — FIXED
This build fixes a template-literal quoting issue that caused a SyntaxError in Node.

## First run
```zsh
cd ~/desktop/trading/spaghetti_mac_v2_3a
chmod +x run_spaghetti_html.command Refresh.command
./run_spaghetti_html.command
```

## Refresh
```zsh
./Refresh.command
```

### Defaults
TOP_N=30
INTERVAL=5m
HOURS=24
OUTDIR=out_spaghetti_html
LABEL_BASE_ONLY=true
TZ_NAME=America/Chicago
