---
name: watchlist-sync
description: Keep the TradingView watchlist in sync with Tactical Alpha's watchlists — additive only, into the existing sections. Use when the user asks to sync watchlists, says TradingView is missing symbols TA has, or asks whether the lists match.
---

# Watchlist Sync

TA is the master. Its watchlist files are the source of truth; TradingView is the view. This sync adds what TradingView is missing and **never removes anything**, so symbols added by hand in TradingView survive.

## How TradingView stores it

One flat ordered array where section headers are entries prefixed `###`:

```
["###PORTFOLIO - STOCKS & ETFS", "NASDAQ:AMD", …, "###⁤WATCHLIST - AI", …]
```

Section names contain invisible characters (several begin with U+2064). They are matched and rewritten byte-for-byte — never retype a section name by hand.

## Step 1: Plan first, always

```
watchlist_sync_plan
```

Returns per-section additions, TA files with no mapped section, and symbols already present elsewhere. Read it before writing. Show the user what will change if it's more than a couple of symbols.

## Step 2: Apply

```
watchlist_sync
```

Additive only. It rebuilds the full array preserving order, headers and every existing symbol, then writes once and verifies the entry count grew by exactly the number added. If the rebuild would drop anything, it refuses and writes nothing.

Use `dry_run: true` to see the resolved symbols without writing.

## Symbol equivalents

TA stores bare tickers; TradingView needs fully-qualified symbols. Writing a bare ticker creates an entry that doesn't resolve, so equivalents are applied first:

| TA | TradingView | Rule |
|---|---|---|
| `RHM.DE` | `XETR:RHM` | Exchange suffix mapping (`.DE`, `.L`, `.TO`, `.T`, `.HK`, …) |
| `BTC` | `COINBASE:BTCUSD` | **Crypto** — venue and quote currency appended |
| `SPX` | `SP:SPX` | Explicit alias |
| `AMD` | `NASDAQ:AMD` | Looked up via TradingView symbol search |

**Crypto needs particular care.** A bare `BTC` is not a TradingView symbol; it must become `COINBASE:BTCUSD` to match the convention already in the watchlist. Tickers that already carry a quote currency (`BTCUSD`, `SOLUSDT`) keep it.

When a ticker resolves wrongly or has no automatic equivalent, add it to `SYMBOL_ALIASES` in `src/core/watchlist_sync.js`. An explicit entry always beats a heuristic.

## Deduplicate on the resolved symbol

The check must compare the **resolved** symbol against the existing list, not the source ticker. `RHM.DE` and `XETR:RHM` are the same instrument under different names — comparing raw tickers reports it missing when it is already there.

This matters beyond tidiness: TradingView rejects the **entire write** with `422 duplicated_symbols` if any symbol repeats, so one duplicate fails the whole sync.

## Unmapped files

Several TA files have no section mapping — screens and derived lists like `watchlist_buy_signals.csv`, `watchlist_hyper_growth.csv`, `watchlist_pillar2.csv`. They are **reported, not guessed at**. Adding a screen's output to the wrong section is silent and tedious to undo.

To map one, pass `mapping`:

```
watchlist_sync_plan  mapping={"watchlist_pillar2.csv": "MIX"}
```

The `PORTFOLIO - *` sections are deliberately unmapped — they reflect holdings and belong to TA's portfolio, not a watchlist file.

## Guardrails

- **Plan before applying.** This is a 300+ symbol list the user has curated.
- **Never remove.** If the user wants something gone, they remove it themselves — TA being missing a symbol is not evidence they want it deleted.
- If `watchlist_sync` refuses to write, do not retry blindly. It refuses only when the rebuild would lose data.
- A backup of the list lives in `backups/`. Take a fresh one before any structural change.
