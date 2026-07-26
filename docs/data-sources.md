# Data Sources

What each source knows, and how current it is. **Freshness is the thing people get wrong** — a successful call says the service is up, not that the data is recent.

## Freshness at a glance

| Source | Updated | Trust for "right now"? |
|---|---|---|
| TradingView chart | Live, streaming | Yes |
| TA portfolio / alerts / earnings | Through the day | Yes |
| TA regime / macro | Daily, EOD pipeline | Same-day, check the timestamp |
| TA gamma walls | Weekdays after ~19:30 UTC | Yes if `age_hours` < 30 |
| WRDS CRSP daily | Annual vintage, **ends 2024-12-31** | **No** — research only |
| CapIQ key developments (via WRDS) | Historical archive | **No** — has ~no future-dated rows |

## Tactical Alpha API

Base `https://tacticalalpha.io`, header `X-API-Key`. Every response carries `X-Data-Generated-At` and `X-Data-Age-Hours` from the source file's mtime. `ta_*` tools surface this as `freshness`.

### Most useful for trading

| Endpoint | Tool | Holds |
|---|---|---|
| `/api/walls` | `walls_*` | `Ticker,TV_JSON` — gamma walls per watchlist symbol, ready for the indicator |
| `/api/portfolio` | `ta_portfolio` | 73 positions with entry, current and high price |
| `/api/earnings` | `ta_earnings` | Upcoming reports with `days_until` and `risk_level` |
| `/api/regime` | `ta_regime` | Stage, **sizing**, volatility, HMM, recession, geopolitical |
| `/api/alerts` | `ta_alerts` | Severity-tagged alerts per ticker, with actions |
| `/api/gamma` | `ta_get` | Dip opportunities with limit prices |
| `/api/sectors` | `ta_regime detail=sectors` | 43 sectors with SMA50, signal, 7d/21d returns |
| `/api/watchlists` | `ta_get` | Every TA watchlist file with size and mtime |
| `/api/v1/sync/{dataset}` | `ta_get` | Generic dataset route — CSV bodies |

`/api/regime` is the richest single call. Its `sizing` block (`max_new_position_pct`, `position_multiplier`, `gamma_protocol_active`) is what should inform position size — not a naive percent-of-account.

Reachable via the generic sync route: `walls_json`, `walls_report`, `gamma_scan_results`, `pif_results`, `exit_decisions`, `entry_decisions`, plus any SHARED dataset (`/api/v1/sync` lists ~135).

**403 on the ledger is deliberate**, not an auth problem — see [architecture.md](architecture.md).

### Gamma walls

`/api/walls` serves `Ticker,TV_JSON`: two columns where the second is the compact payload TA's own scanner emits. Use it **verbatim** — rebuilding it risks drifting from TA's arithmetic.

Parsing gotcha: the JSON column is unquoted and full of commas. Split on the **first** comma only; a normal CSV split shreds every row.

Schema:

| Key | Meaning |
|---|---|
| `dCW`/`wCW`/`mCW` | Call OI wall — daily / weekly / monthly expiry |
| `dPW`/`wPW`/`mPW` | Put OI wall |
| `dCGX`/`wCGX`/`mCGX` | Call GEX wall |
| `dPGX`/`wPGX`/`mPGX` | Put GEX wall |
| `dS`/`wS`/`mS` | Strength: 4 when either side's OI clears TA's threshold, 2 otherwise, 0 = no data |
| `flip` | Gamma flip, from the weekly horizon (daily as fallback) |
| `im` | Implied move |
| `vix`/`vvix` | Read live from TA |
| `ts` | Snapshot time — what the indicator uses to decide it is stale |

Coverage is ~44 tickers and tracks TA's watchlist: equities and ETFs with a liquid option chain. Crypto and FX have none. **A zero is honest; an invented level is not.**

## WRDS

PostgreSQL at `wrds-pgdata.wharton.upenn.edu:9737`. Entitlements differ per institution — always discover with `wrds_list_schemas` → `wrds_list_tables` → `wrds_describe_table` rather than assuming a dataset exists.

Confirmed present: `crsp` (returns), `comp` (Compustat), `ibes` (estimates), `optionm`, `ciq` (**Capital IQ**), `ravenpack`, `wrdsapps`. 1048 schemas total.

Use it for the question a chart cannot answer: *did this rule ever have edge?* `wrds_backtest_signal` reports the signal against the unconditional baseline over the same names and dates — a 58% hit rate means nothing if the base rate was 57%.

Caveats that belong in any result you report:
- Forward windows overlap, so `edge_over_stderr` is indicative, not a p-value
- Testing a current watchlist is survivorship-biased; any edge is an upper bound
- Returns are gross of costs
- Connections authenticate slowly — a timeout is usually the handshake, not bad credentials

## rules.json

The user's own criteria, at the project root (git-ignored). `rules_init` creates it; `morning_brief` falls back to built-in defaults and the live TradingView watchlist when it's absent, flagging `using_defaults: true`.

Holds `watchlist`, `timeframes` (highest first — first is bias, later ones timing), `bias_criteria`, `risk_rules`, `max_symbols`.

When `using_defaults` is set, say so. Generic criteria presented as the user's own system is worse than no brief.
