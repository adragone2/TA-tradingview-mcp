# Architecture

How the pieces connect, and which machine each one runs on.

```
                      ┌──────────────────────────────┐
   your session ─────►│  TradingView MCP (this repo) │
                      │  124 tools, runs locally     │
                      └──────┬───────────────┬───────┘
                             │               │
                    CDP :9222│               │HTTPS + X-API-Key
                             ▼               ▼
                  ┌────────────────┐   ┌──────────────────────┐
                  │  TradingView   │   │  Tactical Alpha (TA) │
                  │  Desktop       │   │  VPS, FastAPI :47892 │
                  │  local         │   │  tacticalalpha.io    │
                  └────────────────┘   └──────────────────────┘

                      ┌──────────────────────────────┐
   your session ─────►│  wrds-mcp (separate server)  │
                      └──────────────┬───────────────┘
                                     │ PostgreSQL :9737
                                     ▼
                            ┌────────────────┐
                            │  WRDS          │
                            │  CRSP/Compustat│
                            │  IBES/CapIQ    │
                            └────────────────┘
```

## TradingView MCP — the chart layer

Runs on the local machine. Talks to TradingView Desktop over Chrome DevTools Protocol on port 9222, driving the same JavaScript API the UI uses.

This means **it operates the user's real chart**. Changing symbol, drawing, or switching layout is visible to them immediately. Anything that sweeps symbols must restore where they were.

TradingView Desktop is an Electron app. Two consequences that repeatedly matter:

- The **tab strip is application chrome**, outside the page. CDP input never reaches it, and `Target.createTarget` is unsupported — so tabs cannot be created or closed programmatically, only listed and switched.
- Panels can be `position: fixed` or exist as duplicate hidden nodes. Visibility must be measured by size, not `offsetParent`.

## Tactical Alpha — the master system

Runs on a VPS (`tacticalalpha.io`, FastAPI on 47892 behind nginx). Authenticated with `X-API-Key`; the key is read from `.env` or the file `TA_ENV_FILE` points at, and never appears in tool arguments.

TA is oriented around **investing**: portfolio, macro, regime, sector rotation, gamma walls, earnings. It owns the watchlists and the databases. It computes things this MCP should never re-derive.

The division of labour:

| | TA | This MCP |
|---|---|---|
| Horizon | Weeks to years | Intraday to weeks |
| Owns | Positions, watchlists, macro, walls | Chart state, drawings, Pine |
| Answers | "What do I hold, what's the regime, when do they report" | "Where is price, what are the levels, where's my entry" |

Two independent morning briefs exist and are **not** duplicates: `ta_investing_brief` is TA's portfolio view; `morning_brief` is the technical view built from live charts. Don't conflate them.

### Freshness

TA stamps `X-Data-Generated-At` and `X-Data-Age-Hours` on responses, taken from the **source file's mtime, not request time**. A 200 says the API is up, not that the data is current. This is load-bearing: TA's walls scanner was once silently starved of its execution lock for five days and served stale walls with no error.

### What is deliberately unreachable

The financial ledger — `lot_ledger`, `cash_balance`, `realized_pnl`, `options_ledger`, tax datasets — returns 403 for this key by design. A charting key should not carry cost basis and share counts. Don't try to route around it.

## WRDS — the research layer

A separate MCP server (`wrds-mcp/`), because it shares nothing with the chart: different data, its own `pg` dependency, no CDP.

Read-only by construction: SELECT and WITH only, write and DDL keywords rejected before the query leaves the machine, and a LIMIT applied when the query has none. WRDS grants are read-only anyway; this is defence in depth on a shared institutional resource.

**Not real time.** CRSP daily ends 2024-12-31. Use it to validate a rule, never to describe today. Its licence is institutional — check the terms before using it outside permitted research.

## Where credentials live

| Secret | Location | Notes |
|---|---|---|
| TA API key | `.env` (git-ignored) or `TA_ENV_FILE` | Never in tool arguments or chat |
| WRDS login | pgpass (`%APPDATA%\postgresql\pgpass.conf` or `~/.pgpass`) | Read directly; never copied |
| TradingView session | The Desktop app's own login | Nothing to configure |

`.env` and pgpass are both git-ignored. `ta_status` and the WRDS check report *whether* a credential is configured, never its value.
