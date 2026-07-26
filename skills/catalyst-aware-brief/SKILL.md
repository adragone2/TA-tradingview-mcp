---
name: catalyst-aware-brief
description: Run the morning brief, then check each candidate for upcoming earnings or events and demote setups with a catalyst inside the holding window. Use when the user wants their session bias with event risk factored in, or asks "what should I trade today" on a watchlist containing stocks or ETFs.
---

# Catalyst-Aware Morning Brief

`morning_brief` reads charts. It knows nothing about the calendar — so it will happily rank a clean technical long in a stock that reports earnings tomorrow. This skill layers event risk on top of the technical read.

## Step 1: Technical scan

Run `morning_brief`. Grade every symbol against `rules.bias_criteria` and follow the `instruction` field in the response — it defines the output format and tiering.

Respect its constraints:
- KEY LEVEL must come from `drawn_levels`, `drawn_labels`, or the high/low in `price_action`. Never invent a price.
- If a symbol has `error` or `warning`, say its reading is unreliable rather than grading it.

## Step 2: Decide which symbols need a catalyst check

Only equities and ETFs have earnings. Skip the lookup for:
- Crypto (BTCUSD, ETHUSD, anything on BINANCE/COINBASE/BITSTAMP)
- FX pairs and spot metals
- Futures continuations (ES1!, NQ1!) — check macro events instead, not earnings

Check **only Tier A and Tier B symbols**. Looking up catalysts for a C-tier name the user won't trade wastes calls and time.

## Step 3: Look up the upcoming catalyst

Use `mcp__brave-search__brave_web_search` (or `brave_news_search` for recent announcements):

```
"<TICKER> next earnings date confirmed"
```

Treat search results as **unverified**. An earnings date scraped from a web page is a claim, not a fact.

> **Why not WRDS?** WRDS is not a forward calendar. Verified against this
> subscription: `ciq_keydev.wrds_keydev` holds a deep historical event archive
> but essentially no future-dated rows. Do not query it for "when does X
> report" — it will not know. Use it for Step 3b instead.

For each symbol record: the event, the date, and where it came from.

## Step 3b: Historical base rate (optional, needs WRDS)

If the `wrds_*` tools are connected, this is where they earn their place. Rather than guessing how much an event matters, measure it:

- `ciq_keydev.wrds_keydev` — past events per company, with `eventtype`, `headline`, `announcedate` and a `gvkey` to join on
- CRSP daily returns — the actual move around those dates

That supports statements like "this name has moved ±8% on its last eight earnings dates", which is far more useful than "earnings soon".

Rules:
- State the sample size. Eight events is a hint, not a distribution.
- Historical reaction size is context for **sizing and expectation**, never a prediction of direction.
- If WRDS isn't connected, skip this step silently — the brief still works without it.

## Step 4: Apply the holding window

Ask the user their intended holding period if it isn't obvious from `rules.json`. Default assumptions:
- Intraday / scalp → only today's events matter
- Swing (days to weeks) → anything within ~10 trading days matters

Then adjust tiers:
- **Catalyst inside the window → demote one tier** and state why. A Tier A setup into earnings becomes Tier B with "reports in 2 days" attached.
- **Catalyst on the day → flag explicitly.** Do not silently rank it.
- **No catalyst in the window** → leave the tier alone.

Never *promote* a symbol because it has a catalyst. An upcoming event is risk, not an edge.

## Step 5: Report

One line per symbol, catalyst appended:

```
SYMBOL | BIAS: bullish | KEY LEVEL: 178.50 | CATALYST: earnings 2026-08-04 (5d) | WATCH: hold above 20 EMA
```

Then the tiers, then a one-sentence market read.

Close with a **Data confidence** line naming where catalyst dates came from — "CapIQ" or "web search, unverified — confirm before sizing". If a lookup failed, say the symbol has no catalyst data rather than implying it has no catalyst.

## Guardrails

- This is the user's own criteria plus calendar context. It is not trade advice, and no tool here places an order.
- Never state an earnings date as confirmed on the strength of a search snippet. Say where it came from.
- If no catalyst source is available at all, still deliver the technical brief and say the catalyst layer was skipped. A brief without event data beats no brief — but silently omitting it would let the user assume it was checked.
