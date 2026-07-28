# Troubleshooting

**First move, always: `tv_doctor`.** It checks node, the TradingView install, port 9222, whether the MCP server loads, a live chart read, and `rules.json` — and every failing check carries the exact command to fix it. It distinguishes causes that otherwise look identical.

## Known breakages on TradingView Desktop 3.3

Verified against a live install. These are platform limits, not bugs to retry through.

| Symptom | Cause | What to do |
|---|---|---|
| `tab_new` / `tab_close` fail | The tab strip is Electron application chrome. CDP input reaches the web contents but not the strip, and `Target.createTarget` is unsupported. | Open or close tabs by hand, then `tab_list` / `tab_switch`. |
| `alert_create` fails via DOM | The old dialog automation targeted `[aria-label="Create Alert"]`; the control is `"Create alert"`, and setting the price input never reached React's state. | Fixed — `alert_create` now uses the pricealerts REST API. |
| Pine Editor "won't open" | It moved out of the bottom widget bar. `bottomWidgetBar.showWidget()` still exists and still returns cleanly, but opens nothing. | Fixed — `ui_open_panel` drives the toolbar button and verifies. |
| Pine Editor reported closed while visible | Two `.monaco-editor.pine-editor-monaco` nodes exist (a 0×0 template and the real one), and the panel is `position: fixed` so `offsetParent` is null. | Fixed — detection measures the largest instance by area. |
| Chart stuck in the past, every pane "This symbol doesn't exist" | Replay was started at a date the symbol has no data for. The feed cannot recover in place. | **Reload the chart.** It returns at realtime from the saved layout. `replay_start` now refuses dates with no data. |
| "Leave current replay?" dialog blocks everything | `leaveReplay()` is the toolbar's exit button and opens a confirmation. It is not a programmatic exit. | Use `replay_stop` (which calls `stopReplay`). Dismiss the dialog if it appears. |
| CDP reads the wrong chart after switching tabs | Activating a tab does not move an existing CDP session. | Fixed — `tab_switch` rebinds and verifies. |

## TA API

| Symptom | Meaning |
|---|---|
| `403` with "not SHARED" | The dataset is user-scoped and that route only serves SHARED data. **Not** an auth problem — don't go hunting the key. |
| `403` on `lot_ledger`, `cash_balance`, `realized_pnl` | Deliberate. A charting key does not carry cost basis. Don't route around it. |
| `401` | Genuinely the key. Check `TA_API_KEY` / `TA_ENV_FILE`. |
| Reachable but data looks old | Read `age_hours`. Walls past ~30h on a trading day mean TA's scan didn't run — report it upstream. |
| `ta_health` fails entirely | The VPS or network, not your key — `ta_health` is unauthenticated for exactly this reason. |

## WRDS

| Symptom | Meaning |
|---|---|
| "Connection terminated due to connection timeout" | Almost always the slow authentication handshake, **not** bad credentials. Raise `WRDS_CONNECT_TIMEOUT_MS`; the default is already 60s. |
| Query rejected as read-only | By design. Only `SELECT` and `WITH` are accepted. |
| Dataset "not found" | Entitlements differ per institution. Discover with `wrds_list_schemas` rather than assuming. |
| Query times out | WRDS tables are enormous (`crsp.dsf` is hundreds of millions of rows). Filter by date and identifier; prefer aggregates. |

## Walls

| Symptom | Meaning |
|---|---|
| "No Institutional Matrix indicator on this chart" | Wrong layout — `layout_switch "TA-Trading"`. |
| "No wall data for X" | Not in TA's coverage (~44 tickers with liquid option chains). Crypto and FX never have walls. Say so; don't write zeros. |
| Indicator shows `DATA STALE (Nh)` | The `ts` in the payload is old. Re-run `walls_apply`; if still stale, TA's scanner hasn't run. |
| Wrote walls but the indicator didn't change | `walls_apply` verifies the write and throws if it didn't take. If it threw, the study was removed or its input layout changed. |

## Things that look broken but aren't

- **`tv_doctor` says TradingView isn't installed while it's clearly running.** On Windows it may be a Microsoft Store (MSIX) package, whose folder can't be listed. Doctor queries the package and passes the check with an advisory when CDP is live.
- **A Git Bash command sends a path to the wrong place** (`/api/...` becoming `C:/Program Files/Git/api/...`). MSYS path conversion. Prefix with `MSYS_NO_PATHCONV=1`.
- **`npm run test:cli` shows 2 failures.** A pre-existing libuv teardown assertion on Windows after outbound HTTPS. The commands succeed; only the exit code is corrupted.

## The meta-lesson

Eight tools in this codebase have been found reporting `success: true` while doing nothing — because a test existed that asserted something which could not fail. If a tool claims success but the chart or account didn't change, **believe the chart**. Verify state independently before reporting a result.

## Drawings that will not clear

**Symptom:** `draw_clear` reports `removed: 0` while the chart is visibly
covered in old lines — often the same set of levels stacked several times over.

**Cause:** TradingView entity IDs are **session-scoped**. When the desktop app
restarts, every ID in the drawing registry stops matching a live shape,
`prune` correctly drops it, and the drawings themselves stay on the chart with
nothing left to identify them by. `draw_clear scope:"mcp"` cannot see them, and
`scope:"all"` would take the user's own drawings too.

**Fix:**

```bash
node scripts/clear-orphans.js
```

Dry run by default. It identifies our drawings by their **label text** rather
than by ID, and removes only shapes whose text matches a format this toolchain
generates — anything unrecognised, including every unlabelled hand-drawn shape,
is left alone.

| Flag | Effect |
|---|---|
| `--apply` | Actually delete. Without it, nothing changes |
| `--all-mcp` | Also remove drawings the registry still tracks. **Use this to clear the charts** — without it the sweep only recovers what was lost, and leaves the current run's drawings in place |
| `--tickers A,B` | Limit the sweep |

The sweep visits the union of TA's actionable list, the portfolio, the
TradingView watchlist, and every symbol the registry has ever recorded drawing
on. All four are needed: TA's list drifts, and a symbol that drops off it keeps
its drawings forever otherwise — CARG survived a full sweep with 17 shapes for
exactly that reason.

Measured on 2026-07-28: 670 shapes across 48 charts, 69 still trackable. The
first pass removed 545 orphans; a second with `--all-mcp` cleared the remaining
tracked drawings. 133 symbols now sweep clean with 18 hand-drawn shapes
preserved.

**If you add or change a drawn label, append its format to
`MCP_TEXT_SIGNATURES` in `src/core/orphans.js`.** A label with no signature
leaks a drawing that can never be cleaned up. Signatures are **append-only** —
retired formats must stay, because an orphan was by definition written by older
code. `tests/orphans.test.js` lifts every label template out of the review
source and asserts the matcher recognises it.

