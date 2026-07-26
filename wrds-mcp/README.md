# wrds-mcp

Read-only MCP server for [WRDS](https://wrds-www.wharton.upenn.edu/) over PostgreSQL. Separate from the TradingView server — different data, its own dependency, no CDP.

> [!IMPORTANT]
> **WRDS data is licensed to your institution.** Check your subscription terms before using it outside permitted research, and do not redistribute it. Terms differ by dataset (CRSP, Compustat, IBES and Capital IQ each have their own). That's your call to make, not this tool's.

## What it's for — and what it isn't

**Good for:** historical research. Did setups matching your `bias_criteria` actually outperform over 10 years? How often did an earnings date inside your holding window wreck a Tier A setup? Those questions are unanswerable from a live chart, and this is how you answer them.

**Not for:** live data. WRDS updates periodically — daily to quarterly depending on dataset. It is **not** a real-time feed and **not** a forward earnings calendar. Use the TradingView tools for current prices and web search for upcoming event dates.

## Setup

```bash
cd wrds-mcp
npm install
```

**Credentials.** If you already use WRDS from Python, R, or `psql`, you likely have a pgpass entry and there is nothing to do — this server reads it directly, so the password never gets copied anywhere. It looks in, in order:

1. `$PGPASSFILE`
2. `%APPDATA%\postgresql\pgpass.conf` (Windows)
3. `~/.pgpass`

matching on host, port, and database. The entry format is:

```
wrds-pgdata.wharton.upenn.edu:9737:wrds:USERNAME:PASSWORD
```

If you have no pgpass entry, `cp .env.example .env` and fill it in — `.env` is git-ignored. Either way, don't paste credentials into a chat.

Then verify, without involving Claude:

```bash
npm run check
```

It prints your username and which file it came from, never the password.

You should see `connected: true`, your WRDS username, and which datasets your subscription exposes. If this fails, the MCP server will fail identically and the error is easier to read here.

Register it once the check passes:

```bash
claude mcp add wrds --scope user -- node /absolute/path/to/wrds-mcp/src/server.js
```

## Tools

| Tool | Purpose |
|------|---------|
| `wrds_health_check` | Connection test; reports which datasets are visible. Start here — it separates a credentials problem from an entitlement problem. |
| `wrds_list_schemas` | Schemas this account can read, with table counts |
| `wrds_list_tables` | Tables in a schema |
| `wrds_describe_table` | Columns and types |
| `wrds_query` | Read-only SQL (`SELECT`/`WITH` only) |

### Discover, don't assume

Entitlements differ per institution — two subscribers see different schemas. Nothing here hardcodes dataset names. Always go `wrds_list_schemas` → `wrds_list_tables` → `wrds_describe_table` before writing a query, because column names also vary by vintage.

Common vendor schemas, *if* your subscription includes them: `crsp` (returns), `comp` (Compustat fundamentals), `ibes` (estimates and announcement dates), `optionm` (OptionMetrics), `ciq*` (Capital IQ). If you have CapIQ access, it is often *through* WRDS — check `wrds_list_schemas` with filter `ciq`.

## Safety

- **Read-only.** Only `SELECT` and `WITH` are accepted. Write and DDL keywords are rejected before the query leaves this machine, and stacked statements are refused. WRDS grants are read-only anyway; this is defence in depth on a shared institutional resource.
- **Bounded.** A query without `LIMIT` gets one (default 1000, max 50000). Statement timeout defaults to 120s so a runaway join can't pin a connection.
- **Parameterised.** Pass values as `$1, $2` with `params` rather than interpolating them.

## Query notes

WRDS tables are very large — `crsp.dsf` is hundreds of millions of rows. Always filter by date range and identifier, and prefer aggregates to pulling raw rows. An unfiltered `SELECT *` will time out.

**Connections can be slow to establish.** Authentication sometimes takes far longer than a local Postgres would, so `connectionTimeoutMillis` defaults to 60s. Raise it with `WRDS_CONNECT_TIMEOUT_MS` if you see `Connection terminated due to connection timeout` — that error means the handshake was still in progress, not that credentials are wrong.

## Verified against a live subscription

Confirmed working on 2026-07-26 (PostgreSQL 17.10, 1048 schemas visible):

| Dataset | Present |
|---------|---------|
| `crsp` | returns, indexes, treasuries, mutual funds |
| `comp` | Compustat fundamentals, Execucomp, segments |
| `ibes` | estimates, actuals, guidance |
| `ciq` | **Capital IQ** — key developments, transcripts, ratings, transactions, capital structure |
| `optionm`, `ravenpack`, `wrdsapps` | options, news analytics, linking tables |

If you have Capital IQ access, it is likely *through* WRDS — check `wrds_list_schemas` with filter `ciq`.

### It is not a forward calendar

Measured on this subscription: `ciq_keydev.wrds_keydev` is a deep historical event archive with essentially **no future-dated rows**. Don't ask it when a company next reports — it doesn't know. Use it for historical base rates ("how has this name moved on its last eight earnings dates") and get upcoming dates from a live source.
