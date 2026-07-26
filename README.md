# TradingView MCP Jackson

If you found this from the YouTube video — welcome. This is the improved fork. Everything you need is below.

Built on top of the original [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). Full credit to them for the foundation. This fork adds a morning brief workflow, a rules config, and fixes the launch bug on TradingView Desktop v2.14+.

> [!WARNING]
> **Not affiliated with TradingView Inc. or Anthropic.** This tool connects to your locally running TradingView Desktop app via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass any TradingView paywall. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing happens locally.** Nothing is sent anywhere. No TradingView data leaves your machine.

---

## What's New in This Fork

| Feature | What it does |
|---------|-------------|
| `tv doctor` | One command that runs every setup check — node, TradingView install, CDP port, MCP server load, live chart read, rules.json — and prints the exact fix for anything broken |
| `morning_brief` | One command that scans your watchlist, reads all your indicators, and returns structured data for Claude to generate your session bias |
| `session_save` / `session_get` | Saves your daily brief to `~/.tradingview-mcp/sessions/` so you can compare today vs yesterday |
| `rules.json` | Write your trading rules once — bias criteria, risk rules, watchlist. The morning brief applies them automatically every day |
| `tv rules init` | Creates `rules.json` for you. Missing rules no longer break `morning_brief` — it falls back to your live TradingView watchlist |
| `draw_trade_plan` | One call draws entry, stop, targets (with partial %) and break-even as colour-coded, labelled, non-overlapping lines — and returns R:R per target plus position sizing |
| Safe `draw_clear` | Now removes only drawings this tool created. Your own chart drawings survive; `scope: "all"` is opt-in |
| Visible-by-default colours | Every drawing gets an explicit colour, so labels can't render white-on-white and disappear |
| Launch bug fix | Fixed `tv_launch` compatibility with TradingView Desktop v2.14+ |
| `tv brief` CLI | Run your morning brief from the terminal in one word |

---

## One-Shot Setup

Paste this into Claude Code and it will handle everything:

```
Set up TradingView MCP Jackson for me.

1. Clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git to ~/tradingview-mcp-jackson and run npm install.
2. Register it with: claude mcp add tradingview --scope user -- node ~/tradingview-mcp-jackson/src/server.js
   (use the absolute path, not ~). Confirm with: claude mcp list
3. Create my rules file: npm run tv -- rules init — then open rules.json so I can fill in my trading rules.
4. Make sure TradingView Desktop is running with the debug port: npm run tv -- launch
5. Verify everything BEFORE any restart: npm run tv -- doctor
   Report the result. If any check fails, show me its "fix" line and stop — do not work around it.
6. Once all checks pass, tell me to fully quit Claude (Cmd-Q, not just closing the window) and reopen.
```

Step 5 is the important one: `tv doctor` verifies node, the TradingView install, port 9222, that the MCP server actually loads, and a live chart read — all from the CLI, so it works before the restart that loads the MCP tools.

Or follow the manual steps below.

---

## Prerequisites

- **TradingView Desktop app** (paid subscription required for real-time data)
- **Node.js 18+**
- **Claude Code** (for MCP tools) or any terminal (for CLI)
- **macOS, Windows, or Linux**

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git ~/tradingview-mcp-jackson
cd ~/tradingview-mcp-jackson
npm install
```

### 2. Set up your rules

```bash
npm run tv -- rules init
```

This is optional — without it, `morning_brief` falls back to your live TradingView watchlist and generic bias criteria. Creating the file is what makes it use *your* system.

Open `rules.json` and fill in:
- Your **watchlist** (symbols to scan each morning)
- Your **bias criteria** (what makes something bullish/bearish/neutral for you)
- Your **risk rules** (the rules you want Claude to check before every session)

### 3. Launch TradingView with CDP

TradingView must be running with the debug port enabled.

`tv launch` finds it automatically, including **Microsoft Store installs on Windows** — those live under `C:\Program Files\WindowsApps`, which can't be searched by path and has to be queried as a package:

```bash
npm run tv -- launch
```

Or use the platform scripts:

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

Or use the MCP tool after setup: `"Use tv_launch to start TradingView in debug mode"`

### 4. Add to Claude Code

Easiest and least error-prone — let the Claude CLI write the config, so you never have to guess the path:

```bash
claude mcp add tradingview --scope user -- node ~/tradingview-mcp-jackson/src/server.js
```

Verify it registered:

```bash
claude mcp list
```

<details>
<summary>Editing the config by hand instead</summary>

Claude Code stores user-scoped MCP servers in **`~/.claude.json`**. Merge — don't overwrite — the `mcpServers` object:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/tradingview-mcp-jackson/src/server.js"]
    }
  }
}
```

Replace `YOUR_USERNAME` with your actual username (`echo $USER` on Mac/Linux, `echo %USERNAME%` on Windows). Use an absolute path — `~` is not expanded inside JSON.

Back the file up first: `cp ~/.claude.json ~/.claude.json.bak`

Note: Claude *Desktop* (the chat app, not Claude Code) uses a different file — `~/Library/Application Support/Claude/claude_desktop_config.json` on Mac.
</details>

### 5. Verify — before restarting

Run the full preflight from the terminal. This works *before* the Claude restart, because the `tv` CLI calls the same core functions the MCP tools do:

```bash
npm run tv -- doctor
```

Every failing check prints the exact command to fix it. When all checks pass, fully quit Claude Code (**Cmd-Q** on Mac, not just closing the window) and reopen it — the MCP tools only load in a fresh session.

After restarting, confirm from inside Claude: *"Run tv_doctor"*

### 6. Run your first morning brief

Ask Claude: *"Run morning_brief and give me my session bias"*

Or from the terminal:
```bash
npm link  # install tv CLI globally (one time)
tv brief
```

---

## Morning Brief Workflow

This is the feature that turns this from a toolkit into a daily habit.

**Before every session:**

1. TradingView is open (launched with debug port)
2. Run: `tv brief` in your terminal (or ask Claude: *"run morning_brief"*)
3. Claude scans every symbol in your watchlist, reads your indicator values, applies your `rules.json` criteria, and prints:

```
BTCUSD  | BIAS: Bearish  | KEY LEVEL: 94,200  | WATCH: RSI crossing 50 on 4H
ETHUSD  | BIAS: Neutral  | KEY LEVEL: 3,180   | WATCH: Ribbon direction on daily
SOLUSD  | BIAS: Bullish  | KEY LEVEL: 178.50  | WATCH: Hold above 20 EMA

Overall: Cautious session. BTC leading bearish, SOL the exception — watch for divergence.
```

4. Save it: *"save this brief"* (uses `session_save`)
5. Next morning, compare: *"get yesterday's session"* (uses `session_get`)

---

## Trade Plan Markup

Ask Claude for a plan in plain language — *"mark my entry at 100, stop at 95, targets 110 and 120, half off at the first"* — and it draws every level in one call:

```bash
tv draw plan -d long -e 100 -s 95 --targets 110,120 --breakeven 101
```

Or with partial percentages and position sizing:

```bash
tv draw plan -d long -e 100 -s 95 --targets '[{"price":110,"partial_pct":50},{"price":120}]' --account 10000 --risk 1
```

Each level is a labelled line in its own colour — entry blue, stop red, targets green dashed, break-even grey dotted — with label alignment staggered so nearby levels stay readable. The response includes R:R per target and, when you pass `--account` and `--risk`, the position size implied by your stop distance.

It also refuses plans that contradict themselves: a long with its stop above entry, or a target on the wrong side of the entry, is rejected before anything reaches the chart.

> [!NOTE]
> R:R and position size are arithmetic on the levels **you** supply. This tool does not recommend trades, evaluate setups, or place orders.

### Cleaning up

`draw_clear` removes **only drawings this tool created** — your own lines are left alone:

```bash
tv draw clear                    # remove Claude's drawings, keep yours
tv draw clear -g long-100        # remove just that plan
tv draw clear --scope all        # remove everything, including your own drawings
```

> [!WARNING]
> **Behaviour change:** `draw_clear` used to remove every drawing on the chart. It now defaults to `scope: "mcp"`. If you relied on the old behaviour in a script, pass `--scope all` explicitly.

`tv draw list --points` shows what's on the chart with coordinates and a `created_by_mcp` flag — which is also how Claude reads a trade you drew by hand.

---

## What This Tool Does

- **Morning brief** — scan watchlist, read indicators, apply your rules, print session bias
- **Pine Script development** — write, inject, compile, debug scripts with AI
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read indicator values, price levels, drawn levels from custom indicators
- **Draw on charts** — full trade plans with R:R, trend lines, horizontal levels, rectangles, text
- **Manage alerts** — create, list, delete price alerts
- **Replay practice** — step through historical bars, practice entries and exits with P&L tracking
- **Screenshots** — capture chart state
- **Multi-pane layouts** — 2x2, 3x1 grids with different symbols per pane
- **Stream data** — JSONL output from your live chart for monitoring scripts
- **CLI access** — every tool is also a `tv` command, pipe-friendly JSON output

---

## How Claude Knows Which Tool to Use

Claude reads `CLAUDE.md` automatically when working in this project. It contains the full decision tree.

| You say... | Claude uses... |
|------------|---------------|
| "Run my morning brief" | `morning_brief` → apply rules → `session_save` |
| "What was my bias yesterday?" | `session_get` |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `capture_screenshot` |
| "Switch to BTCUSD daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` |
| "Draw a level at 94200" | `draw_shape` (horizontal_line) |
| "Mark my entry, stop and targets" | `draw_trade_plan` |
| "Clean up the chart" | `draw_clear` (removes only Claude's drawings) |
| "What's the R:R on this?" | `draw_trade_plan` returns it per target |

---

## Tool Reference (86 MCP tools)

### Setup & Diagnostics (new in this fork)

| Tool | What it does |
|------|-------------|
| `tv_doctor` | Run every setup check at once; each failure carries the exact fix command |
| `rules_init` | Create `rules.json` from the template (won't overwrite without `force`) |
| `rules_status` | Show which `rules.json` is in use and where it was searched for |

### Morning Brief (new in this fork)

| Tool | What it does |
|------|-------------|
| `morning_brief` | Scan watchlist, read indicators, return structured data for session bias. Uses `rules.json` when present; otherwise falls back to your live TradingView watchlist. |
| `session_save` | Save the generated brief to `~/.tradingview-mcp/sessions/YYYY-MM-DD.json` |
| `session_get` | Retrieve today's brief (or yesterday's if today not saved yet) |

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use |
|------|------------|
| `data_get_pine_lines` | Horizontal price levels (support/resistance, session levels) |
| `data_get_pine_labels` | Text annotations + prices ("PDH 24550", "Bias Long") |
| `data_get_pine_tables` | Data tables (session stats, analytics dashboards) |
| `data_get_pine_boxes` | Price zones as {high, low} pairs |

**Always use `study_filter`** to target a specific indicator: `study_filter: "MyIndicator"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Multi-Pane, Alerts, Drawings, UI

| Tool | What it does |
|------|-------------|
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_set_symbol` | Set symbol on any pane |
| `draw_trade_plan` | Draw a full trade plan (entry, stop, targets, partials, break-even) as colour-coded labelled lines; returns R:R and position sizing |
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text. Time is optional (`"now"`, `"last_bar"`, ISO date) |
| `draw_list` / `draw_list_groups` | List drawings (flagged by whether this tool created them) and groups |
| `draw_clear` | Remove drawings — **only this tool's by default**; `scope: "all"` to wipe everything |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `tv_launch` / `tv_health_check` | Launch TradingView and verify connection |

---

## CLI Commands

```bash
tv doctor                          # run every setup check, with fixes
tv rules init                      # create rules.json from the template
tv rules path                      # show which rules.json is in use

tv brief                           # run morning brief
tv session get                     # get today's saved brief
tv session save --brief "..."      # save a brief

tv status                          # check connection
tv quote                           # current price
tv symbol BTCUSD                   # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv stream quote | jq '.close'      # monitor price ticks
```

Full command list: `tv --help`

---

## Troubleshooting

**Start here for any problem:**

```bash
npm run tv -- doctor
```

It checks node, the TradingView install, port 9222, whether the MCP server loads, whether a live chart read works, and rules.json — and prints the exact fix for whatever failed. The table below is what it will tell you.

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | TradingView isn't running with `--remote-debugging-port=9222`. Use the launch script. |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Run `claude mcp list` to confirm registration. If it's listed, you didn't fully quit Claude — Cmd-Q, not just closing the window. |
| `mcp_server_loads` fails in `tv doctor` | The server crashes on startup and would fail inside Claude the same way. Fix the error it prints, then re-run. |
| `tv` command not found | Run `npm link` from the project directory, or use `npm run tv -- <command>` |
| `tradingview_installed` fails but TradingView is running | Expected if it's installed somewhere unusual. `tv doctor` reports this as OK when CDP is live, and only warns that `tv_launch` can't auto-start it. Launch it yourself with `--remote-debugging-port=9222`. |
| `morning_brief` — watchlist empty | Add symbols to the `watchlist` array in `rules.json`, or open the watchlist panel in TradingView so it can be read from the chart |
| `morning_brief` uses generic bias criteria | No `rules.json` yet — run `tv rules init` and fill it in with your own system |
| Tools return stale data | TradingView still loading — wait a few seconds |
| Pine Editor tools fail | Open Pine Editor panel first: `ui_open_panel pine-editor open` |

---

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (port 9222)  ←→  TradingView Desktop (Electron)
```

- **78 original tools** + **3 morning brief tools** + **3 setup/diagnostic tools** + **2 drawing tools** = 86 MCP tools total
- **Transport**: MCP over stdio + CLI (`tv` command)
- **Connection**: Chrome DevTools Protocol on localhost:9222
- **No external network calls** — everything runs locally
- **Zero extra dependencies** beyond the original

---

## Credits

This fork is built on [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). The original tool is the foundation — go star their repo.

---

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag.

By using this software you agree that:

1. You are solely responsible for ensuring your use complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. This tool accesses undocumented internal TradingView APIs that may change at any time.
3. This tool must not be used to redistribute, resell, or commercially exploit TradingView's market data.
4. The authors are not responsible for any account bans, suspensions, or other consequences.

**Use at your own risk.**

## License

MIT — see [LICENSE](LICENSE). Applies to source code only, not to TradingView's software, data, or trademarks.
