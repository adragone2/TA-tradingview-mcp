# Data Sources

What each source knows, and how current it is. **Freshness is the thing people get wrong** — a successful call says the service is up, not that the data is recent.

## Freshness at a glance

| Source | Updated | Trust for "right now"? |
|---|---|---|
| TradingView chart | Live, streaming | Yes |
| TA portfolio / alerts / earnings | Through the day | Yes |
| TA regime / macro | Daily, EOD pipeline | Same-day, check the timestamp |
| TA gamma walls | Weekdays after ~19:30 UTC | Yes if `age_hours` < 30 |
| FINRA short interest | **Twice a month**, published on ~8 business days' lag | Yes at 1–3 weeks old — that IS the resolution |
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

## FINRA short interest

`short_interest` and `finra_status`. OAuth2 client credentials from `FINRA_CLIENT_ID` / `FINRA_CLIENT_SECRET` in `.env`; the token lasts ~12h and is cached. This is the only field in the toolchain that measures **positioning** rather than price, and every short is future demand because it must eventually be bought back.

**It is context, not a signal.** Shannon, ch. 15: *"a large outstanding short position or short interest ratio by itself is not a reason for buying a stock in anticipation of a short squeeze... Nonetheless, it is an excellent gauge of potential demand."* Attach it to a setup found some other way, like `ta_trading_context`.

| Field | Notes |
|---|---|
| `short_interest` | Shares sold short and not covered, at the settlement date |
| `average_daily_volume` | FINRA's own ADV for the period |
| `days_to_cover` | **Recomputed.** FINRA floors its own figure at 1.00 and caps it at 999.99 |
| `days_to_cover_reported` | Kept beside ours so the clamp is visible |
| `vs_prior_period.driver` | `short_interest` or `average_volume` — **read this first** |
| `shorts_position` | With `with_price: true`, period VWAP as the shorts' cost basis and whether they are underwater |
| `short_pct_of_float` | Always `null`. FINRA publishes no share count — **never infer it** |

**Three traps, all handled, all found by running it against the live API rather than by unit tests:**

1. **`consolidatedShortInterest` is the dataset that covers listed names.** `equityShortInterest` — the endpoint named in FINRA's own docs — is **OTC only** and returns HTTP 204 for a listed symbol, which reads as "no short interest" rather than "wrong dataset". PNC: 204 from one, 14 periods from the other. The two also use different symbol field names (`symbolCode` vs `issueSymbolIdentifier`).

2. **FINRA's `limit` truncates from the OLDEST end.** The API refuses to sort without an EQUAL filter on its partition key, so a limit that binds silently drops the **newest** settlement dates. Asking for 12 periods with limit 24 returned data ending 2026-05-15 when 2026-07-15 existed — and the freshness check then correctly reported 75-day-old data, which looks like a FINRA outage. `fetchSeries` sizes the limit above what the window can hold and retries if it still binds.

3. **Days-to-cover is mostly a volume indicator.** `node scripts/short-interest-driver.js` measured 40 symbols over 1,000 period-over-period changes: **93% of days-to-cover moves of 20% or more (426 of 458) were driven by average volume, not by the short position.** On NVDA, AMZN, GOOGL, META, TSLA, PNC, BAC, PFE, MRK and CYTK it was 100% of their big moves. Worst case KSS 2025-08-15: days-to-cover **+351.5%** while short interest moved **+1.59%** and volume fell 77.5%. Shannon's own Figure 15.1 contains the trap (SIR 12.91 → 4.11, −68%, on a −7% change in the short position). Every result decomposes the change; quote the `driver`, never the bare ratio.

**Squeeze pressure needs LOSING shorts.** Shannon's mechanism turns on the shorts' P&L — shorts holding gains *"are less likely to panic and buy at the first signs of strength."* So a large short position in a still-declining stock is not fuel. `shorts_position` is what tells the two apart, and it is a crude proxy: it assumes the position was built evenly across the settlement period.

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
