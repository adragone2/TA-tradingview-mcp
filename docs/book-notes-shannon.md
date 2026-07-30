# Shannon, Technical Analysis Using Multiple Timeframes (2008) — reading notes

**Read in full — all 198 scanned pages (99 two-up spreads), pp. i–184, every chapter.**

The book was rendered from the owner's own PDF (`books/`, git-ignored) as two-up
spreads and read sequentially. Book page ≈ PDF page − 10.

Notes below are in two parts: the numbered FINDINGS were written first, while
sampling for new capability; the `sNNN` sections that follow are the sequential
read log, in book order, and are the complete record. Where the two disagree
the sequential log is the later and better reading — the sampling pass got the
timeframe→moving-average mapping wrong, for one (Shannon's is role-based, ours
is duration-based; see s103–s104).

## What was built from it

| Finding | Where it went |
|---|---|
| Lookbacks scale LINEARLY with the timeframe ratio, volatility and stops as the SQUARE ROOT | `timeframe_scale`, `src/core/timeframe.js` |
| Short interest and days-to-cover; squeeze pressure needs LOSING shorts | `short_interest`, `src/core/finra.js` — see [data-sources.md](data-sources.md) |
| Days-to-cover is a ratio whose denominator does the work (his own Figure 15.1) | `decomposeDaysToCover`, and the 93% measurement in `scripts/short-interest-driver.js` |
| The timeframe-justification trap, named by the source | `mtf_analyze`'s `focus_timeframe_warning` |
| Extended-hours data is for exits, not entries — stated four separate times | `src/core/session.js` partial-bar guard |

## Still unbuilt, in rough order of value

1. **The four-stage ACTION state machine** (ch 12/13) — short-timeframe stage → ANTICIPATE / PARTICIPATE / EXIT / AVOID, conditioned on the daily stage. The most implementable thing in the book and we have no equivalent.
2. **The three position-size constraints** (ch 16) — risk %, concentration cap, liquidity. His own worked example produces a **65% of capital** position from a 1% risk budget, because a tight stop inflates share count. Check `position_size` returns the binding constraint, not just the risk one.
3. **The touch-count inversion** (ch 7) — more tests of a level makes a BREAK more likely, not less, with an absorption mechanism and two supporting clauses (rising pullback lows, shrinking inter-test interval). Needs a random-walk floor: more touches also means more chances to break.
4. **The two exits our taxonomy lacks** (ch 16) — gap-against-trend ≥5%, and the MA-crossover time-correction exit. Both planned and modellable; see `src/core/exits.js`.
5. **The pivot-based hard trailing stop** (Figures 16.4/16.5) — fully algorithmic off `structure_analyze` pivots.
6. **Journal review slices** (Figure 16.2) — his own broker data shows two net-NEGATIVE buckets (stocks over $100, trades held 16–30 min) inside a profitable book. Add direction, share-size, share-price and holding-time slices to `trade-journal`.
7. **Time corrections** (ch 8) — a depth-based pullback detector scores a horizontal, low-volatility digestion as "no pullback" and misses the setup. `volatility_state` is arguably already this detector.

## FINDING 1 — structural short squeeze (ch 15). Genuinely new. Mechanical.

The technique, from fig 15.3/15.4:

1. Take the short-interest table across successive settlement periods:
   `date | short interest | avg volume | SIR | VWAP`
2. Compute **VWAP over each settlement window** — that approximates the average
   price at which the shorts *of that window* were initiated.
3. Where current price > that VWAP, the average short from that period is
   underwater. His worked example: period VWAP 42.37 with price ~45.38, so the
   average short was down ~$3.00/share; period 8 alone shorted ~2M shares at
   an average of 40.53.
4. That locates the level above which shorts become vulnerable.

So: **anchored VWAP, anchored to short-interest settlement dates, used to find
the short side's cost basis.** We already ship `anchored_vwap` — Shannon is the
populariser of AVWAP — so the missing pieces are the short-interest series and
the settlement-window anchoring, not the VWAP maths.

His four screen criteria:
1. **Uptrend on the daily**, minimum above a RISING 50-day MA. At/near all-time
   highs is best: no motivated supply when every long is winning. Explicitly
   NOT a downtrend candidate — there the shorts are in control and have no
   reason to repurchase.
2. **Absence of hedging vehicles** — options, other share classes, warrants,
   convertibles, preferreds. No hedge means a more vulnerable short.
3. **Short interest high relative to average volume** (high SIR / days-to-cover
   → harder to repurchase).
4. **Level of potential squeeze** — the VWAP step above.

What we can and cannot do today:
- (1) computable now — scanner has SMA50 and 52-week high.
- (3) needs a short-interest series. NOT in the TradingView scanner columns we
  use. Possibly available from TA. **Open question.**
- (4) needs (3)'s settlement dates plus `anchored_vwap`.
- (2) needs securities-master data. Not available.

### DATA VERDICT — checked 2026-07-29, technique is BLOCKED

TradingView scanner returns **null** for every short-interest field tried:
`short_interest`, `short_interest_ratio`, `shares_short`, `short_ratio`,
`days_to_cover`, `float_shares_percent_shorted`, `short_percent_of_float`,
`shares_float`. Only `float_shares_outstanding` resolves (TSLA 2.76e9).

TA exposes nothing matching short interest either.

**WRDS — checked properly, and this is the precise answer.** The catalog LISTS
every short-interest table, which is misleading: WRDS shows the whole catalog
regardless of entitlement, so visibility is not access. Tested individually:

    denied    shortint.wrds_finra_short_interest
    denied    shortint.finra_short_interest
    denied    shortint.finra_short_interest_otc
    denied    shortint.sec_shortint_legacy
    READABLE  crsp.dsf
    READABLE  crsp.stocknames

Error is `permission denied for schema wrds_finra_short_interest`. So the
missing thing has a NAME: that one WRDS schema entitlement.

The schema itself is exactly Shannon's fig 15.3 — `settlementdate`,
`currentshortpositionquantity`, `averagedailyvolumequantity`, and
`daystocoverquantity` (his SIR, already computed), plus gvkey/cusip for linking
to CRSP. If the entitlement were added, criteria 3 and 4 both fall out, and
`crsp.dsf` already supplies the price and volume needed to compute VWAP over
each settlement window.

Two routes:
- ask the WRDS administrator for the `wrds_finra_short_interest` schema; or
- FINRA publishes equity short interest publicly twice a month, which needs no
  subscription at all (would need verifying before relying on it).

Either way this stays a VALIDATION exercise first, not a live screen: CRSP ends
2024, so the right first question is whether the technique has any edge — which
is the correct order anyway.

So of the four criteria: **1 computable, 2 unavailable, 3 unavailable, 4 depends
on 3.** The technique is real and mechanical and we cannot implement it. It is a
DATA acquisition question, not an engineering one — a short-interest series with
settlement dates (FINRA publishes twice monthly) plus `anchored_vwap` would make
criterion 4 a small build. Do not part-build it: criterion 1 alone ("uptrend
above a rising 50 SMA") is not a squeeze screen, it is a trend screen, and
shipping it under the squeeze name would be the sort of dressed-up
approximation this repo exists to avoid.

## FINDING 2 — five-outcome taxonomy (ch 16)

"There are five possible outcomes of a trade — a large winner, a small winner, a
breakeven trade, a small loss or a large loss. It is the large losses that must
be avoided at all cost."

Ours records barrier hit + R multiple, which is finer. But the five-bucket lens
is about the SHAPE of the distribution and specifically tail control, which
expectancy alone hides — two books with identical expectancy differ entirely if
one has a large-loss bucket and the other does not. Cheap addition to
`risk_expectancy` reporting; not a new tool.

Also names "death by 1,000 paper cuts" — capital lost to many small losses,
which is our turnover/cost point under another name (`turnover_cost`).

## Nothing-new so far
- ch 1: discipline, "listen to the message of the market", systems vs
  discretionary. His two questions ("where has it come from" for stops, "where
  can it go" for targets) are `draw_trade_plan`.
- Four-stage framework = Weinstein = our Wyckoff phases, and ours carries a
  measured noise floor (classifyPhase 100%, never abstains) that his does not.

### yfinance — verified 2026-07-29, this is the live source

yfinance 0.2.66 is installed. `Ticker.info` carries the short-interest block
(the raw quoteSummary endpoint 401s now — Yahoo wants a crumb, the library
handles it):

    sharesShort, sharesShortPriorMonth, shortRatio (= days to cover = his SIR),
    shortPercentOfFloat, dateShortInterest, sharesShortPreviousMonthDate

Live values: TSLA shortRatio 1.63, GME 12.78, both settled 2026-07-15 with the
prior settlement dated 2026-06-15.

So against Shannon's four criteria:
  1. uptrend above rising 50 SMA        — have it (scanner)
  2. absence of hedging vehicles        — still no data
  3. short interest high vs avg volume  — HAVE IT (`shortRatio`)
  4. VWAP where shorts were initiated   — PARTIAL. `dateShortInterest` gives one
     anchor, so `anchored_vwap` from it yields "the average short of the most
     recent window is up/down X". Not his ten-window cost-basis ladder, but that
     is the practical core of the idea.

**The awkward part, and it decides the recommendation.** yfinance is a
point-in-time SNAPSHOT — no history — and the WRDS entitlement that would give
the historical series is denied. So we could build a screen we have no way to
VALIDATE. That is exactly what CLAUDE.md forbids: a result with no trial count
flatters itself.

Recommendation: wire the data (cheap, real, live) and expose the components as
MEASUREMENTS — days-to-cover, short-side cost basis versus price — not as a
"squeeze screen". Same treatment the 1-2-3 got: implemented, honest about what
is unestablished, not promoted to a signal until something can test it.
Validation needs either the WRDS schema or FINRA's public twice-monthly files
accumulated forward from now.

## FINDING 3 — Dow's three trends, WITH durations (ch 11). Corroboration, and close.

Shannon relays Dow Theory's trend taxonomy with explicit lengths:

  primary trend   ("oceanic tides")  a few months to several years
  secondary       ("waves")          TWO WEEKS to THREE MONTHS  <- swing traders
  minor           ("ripples")        LESS THAN TWO WEEKS        <- day traders

In trading days: minor <10, secondary ~10-63, primary 63+.

Against our own horizon zones (Jegadeesh 1990, Lehmann 1990, Jegadeesh & Titman
1993):

  reversal      <= 21 d
  contested     22-62 d
  continuation  >= 63 d

Dow's **secondary movement ends exactly where our continuation zone begins**,
and his minor trend sits inside our reversal zone. Our WEEKS bucket (10-21d) is
Dow's secondary movement; our MONTHS bucket (63+) is his primary trend.

Dow also said minor trends are hard to predict "because they are often
emotionally driven events" — that is the reversal zone, where momentum fails —
and that the biggest money comes from following the longer timeframes, which is
the continuation zone. A century-old qualitative taxonomy landing on the same
boundaries later measured empirically is worth recording in
docs/strategy-horizons.md.

Unquantified claim worth noting: "the fresher the primary trend is, the less
likely it is to reverse." Trend AGE as a variable. Testable, untested here.

## FINDING 4 — time stops, scaled by horizon (ch 16). Numbers.

  day trade      15-30 minutes (emphasis on 30 if the market cooperates)
  swing trade    2-3 hours to get moving, else sell near cost basis
  position trade 1-2 days
  and: after a time stop he will RE-ENTER if it later looks ready

The premise is stated separately in ch 17: **"Positions that are entered
correctly will tend to move quickly in your favor."** That is the falsifiable
core of a time stop, and it IS testable with the triple-barrier machinery we
already have — compare the distribution of time-to-first-favourable-excursion
for winners against losers. If good entries really do move fast, time stops earn
their place empirically instead of by assertion. NOT YET TESTED.

Note his time stops do not scale with the intended HOLD (15-30min of a ~1h day
trade is 25-50%; 2-3h of a multi-day swing is far less). They scale with how long
the ENTRY SIGNAL should take to work. Different quantity.

## FINDING 5 — trailing stops, and measured slippage (ch 16)

Room to give a trail "depends in great part on historical volatility and the
price of the stock" — ATR-scaled trailing, i.e. `position_size_atr` and the
sqrt-law factor in `timeframe_scale`.

His worked order book: a $0.15 trail triggered at 27.74 and filled at 27.71 and
27.65. So 3-9 cents lost on a 15-cent trail — **20-60% of the stop distance gone
to slippage**, on a liquid name, in 2008. That is a concrete measured instance of
exactly what `gap_risk` and `luld_band` argue: a stop is a market order once
touched. Worth citing.

He also uses MA CROSSOVERS as exits, not entries. Given Grimes measured the
triple-MA trend indicator as inverted on ~903k equity observations, using it to
leave rather than to enter is the more defensible application of the same object.

## Fifth independent source on the self-fulfilling justification

ch 11: "The common recognition of any technical area or event brings about a
self-fulfilling event as price approaches that area." After Farley, Aziz,
Emanuel and Shannon's own ch 10. Still unfalsifiable; still contradicted by the
only source that measured it.

## Read status
COVERED: front matter, TOC, ch 1, ch 10 (fig 10.4 -> built), ch 11 (Time), ch 15
(short squeeze), ch 16 (risk/exits), ch 17 (aphorisms).
NOT READ: ch 2-6 (the four stages = Weinstein = our Wyckoff phases, which carry a
measured noise floor his do not), ch 7 S&R, ch 8 Trends, ch 9 Volume, ch 12-14,
ch 18. Judgement: these are the four-stage framework plus worked chart examples.
Spreads remain on disk if any specific chapter is wanted.

## SEQUENTIAL FULL READ — log

s001-010 front matter, blurbs, TOC, preface, introduction.
  - "the lowest-stress way to profit consistently is through trend following"
  - "the number one job of a trader is that of risk manager"
  - "knowing WHEN to be involved is just as important as knowing WHAT to be in"

s013-018 ch1 Technical Analysis.
  - Systems vs discretionary; he is discretionary, uses computers to screen only.
  - "Being a good stock picker and a successful trader are separate talents."
  - **"on a stand-alone basis, none of these tools really work"** (stochastics,
    RSI, MACD, moving averages) — what works is disciplined implementation of a
    plan. From an author whose own book is built on moving averages.
  - Explicitly rejects the random-walk view, on the grounds that emotions are not
    random. No data offered either way.
  - Three foundations: market discounts; prices move in trends; history rhymes.
  - **He does NOT use classical price patterns** — no H&S, triangles, pennants —
    and says candlestick pattern recognition is "a distraction to measurement of
    capital movement across multiple timeframes." Worth noting given how much of
    our patterns.js is exactly that, and given the two academic tests that found
    candlestick patterns worthless. He reaches the same place by taste.

s021-030 ch2 The Four Stages.
  - Weinstein stage analysis, credited to Secrets for Profiting in Bull and Bear
    Markets. 1 Accumulation, 2 Markup, 3 Distribution, 4 Decline.
  - Stages 2 and 4 are RANGE EXPANSION; stages 1 and 3 are CONTRACTION. Trend
    traders belong long in 2, short in 4, and out in 1 and 3.
  - MA structure per stage: uptrend = short above intermediate above long, all
    positively sloped; downtrend the inverse; stages 1 and 3 = averages crossing
    each other, which he reads as "lack of consensus of trend".
  - Fractal claim: the four stages appear on every timeframe. Fig 2.1 shows the
    same stock in different stages on weekly/daily/30min/1min simultaneously —
    which is the honest version of the MTF problem, not a selling point.
  - Figs 2.4/2.5 map the emotional cycle for LONG holders and SHORT sellers
    separately. The short-seller cycle is the mirror, not the same curve.
  - Our equivalent: wyckoff classifyPhase, and ours carries a 100% random-walk
    rate (never abstains) that his framework has no equivalent of.

s031-038 ch3 Stage 1 Accumulation.
  - Recognition: MAs crossing repeatedly after a prior downtrend; volume slows;
    range contracts.
  - **"The appearance of accumulation is not reason to buy"** (fig 3.2) and
    "while the longer-term moving average still exhibits a negative slope any
    rally attempt should not be trusted" (fig 3.3). A slope condition on the LONG
    average as a veto — computable, and stricter than anything our screens apply.
  - Biggest risk in a stage 1 holding is TIME / opportunity cost, not drawdown.
  - Four clues that accumulation is ending: higher lows; increased volume; more
    FREQUENT tests of one resistance level; long MA flattening to rising.
    `nearest_level_tests` already counts tests — the "more frequent over time"
    derivative is not something we compute.
  - Institutional detail: funds must disclose holdings quarterly, so they sell
    underperformers to avoid "window dressing" embarrassment, and can be net
    seller one month and net buyer the next. A calendar-driven supply effect.

### s055–s070 (pp. 41–56) — ch 6 end, ch 7 Support & Resistance

**ch 6 — short selling in stage 4 (pp. 41–46)**
- *"Because of the greater volatility in a bear market, shorts generally should be traded more aggressively than longs would be in a bullish environment."* — an explicit asymmetry in HOLD PERIOD by direction, not just in size. He covers quickly and re-enters, because counter-trend rallies in a downtrend "can occur *so* suddenly that trading short is more difficult than long."
- *"Do not trust gaps higher in a downtrend, as they have a nasty tendency of reversing."* Concrete: a gap up inside an established series of lower highs/lows is a short setup on a shorter timeframe as the rally fizzles — not a trend-change signal. Pairs with the ch-4 rule (gap DOWN ≥5% breaks a trend) to give a directional asymmetry in how gaps are read.
- End-of-decline tell: **stronger** rallies begin to develop, driven by short covering, and volatility TAPERS. Then higher lows WITHOUT higher highs → stage 1. Note the sequencing claim: higher lows precede higher highs, so a stage-1 detector should not require both.
- *"Bottoms are a process, not an event."*

**ch 7 — the three strength factors (p. 54)**
> The strength and importance of support and resistance levels is influenced by three factors: **the time it takes to form**, **the volume traded during its formation**, **how recently it was developed**.

All three are computable from bars we already have. `levels_find` currently scores by touch count and proximity. Time-to-form (bar span of the consolidation), volume during formation, and recency ("freshness") are a different, testable triple — and Shannon says freshness matters because *"time tends to dull the emotions of participants."*

**⚠️ FINDING — Figure 7.4 caption contradicts the touch-count convention head-on:**
> *"The more times a level of support or resistance is tested, the more likely it is for the stock to VIOLATE that level."*

And he gives an arithmetic mechanism rather than a metaphor: a seller with 500,000 to dispose is worked through 300k on the first test, 125k on the second, leaving 75k — *"the next test may be the one where buyers overwhelm the supply."* Plus a second, independent read on the same figure: the pullback lows RISING between tests (10.50 → 9.25 → 9.50) is buyers "becoming more aggressive through price," and the tests coming closer together is aggression "time-wise."

This is the opposite of "a level tested four times is stronger than one tested twice." Worth checking whether any detector here treats touch count as strength — if so it is scoring absorption as if it were reinforcement. **Testable**: does P(break) rise monotonically with test count? Needs a noise floor: on a random walk, more touches also means more chances to break, so the naive version of this is trivially true. The non-trivial claim is the *conditional* one — P(break | n tests) rising faster than the random-walk baseline — plus the rising-pullback-low and shrinking-inter-test-interval clauses.

- *"True support and resistance is only known AFTER the fact. It is common for amateur technicians to point to a level ... and proclaim a support or resistance level. However, in a trending environment those levels will be breached with regularity."* — a level is a hypothesis, and its prior depends on the trend state it sits in. Argues for `levels_find` reporting the structure_analyze trend alongside each level rather than a bare price.
- The intended USE of a level is not an entry price: *"The focus of a trader should not be to try to buy or sell at a level of support or resistance, but to determine potential levels of buying and selling imbalances and use these areas as a catalyst to study price action on shorter timeframes."* Same shape as the MTF discipline already implemented — the higher timeframe nominates the area, the lower timeframe decides.
- On a break: *"It is not the breaking of the level that is most important, but the subsequent action which confirms or rejects the movement."* This is exactly what `breakout_check`'s 5 measurements do; Shannon is independent support for measuring after rather than at.
- Reinforcement list (p. 54): levels coincide with **price gaps, key moving averages, retracement levels, round numbers, prior high-volume levels**. Round numbers are the one confluence source not currently in `levels_find`.
- Mechanics worth keeping straight: resistance forms by PASSIVE selling and breaks on AGGRESSIVE buying; support forms by passive buying and breaks on aggressive selling. Bar data cannot see passive vs aggressive — this is a depth/tape claim, not a chart claim.

### s071–s086 (pp. 57–72) — ch 7 end, ch 8 Trends, ch 9 Volume opens

**The entry/stop rule, stated plainly (p. 57)** — the most concrete thing in the book so far:
> *"Longs should enter just as the stock makes its first higher high on a short-term timeframe. Waiting longer than the initial breakout point to enter puts your equity at greater risk. An initial protective stop should be placed below the most recent higher low, and the further the stock has traveled from that level, the greater risk exposure."*

Entry = first higher high on the SHORT timeframe (inside a longer-timeframe uptrend). Stop = below the most recent higher low. Risk = distance between them, which grows as you chase. And a hard R:R gate on p. 58: *"If the amount of potential profit is at least three times greater than the level of perceived risk, then the trade setup is worth considering."* Two questions before any trade: *"where has it come from, and where does it have the potential to go?"*

That is fully computable from `structure_analyze` (swing highs/lows) + `levels_find` (the supply overhead for the target) + `draw_trade_plan` (R:R). Worth checking whether the 3:1 gate is anywhere in `rules.json`.

**Figure 7.5 — the mirror of 7.4, plus its second clause:**
> *"The more times support is tested, the more likely it is that the level will fail to hold the stock up. The LOWER HIGHS the stock created before the breakdown revealed sellers becoming impatient."*

So the symmetric pair is: resistance about to break shows RISING pullback lows; support about to break shows FALLING rally highs. Both are the *aggression* clause, and both are computable off pivots. Combined with the absorption count this is a three-clause testable rule, not a saying.

**⚠️ A NUMBER for trend lines (p. 68):**
> *"Like any level of support or resistance found in the market, trend lines become weaker each time they are tested. It is common for the FOURTH TEST of a trend line to be fatal to a trend."*
> *"Paradoxically, the longer anything becomes obvious to a large group of participants, the greater the odds of failure."*

Fourth test. That is a falsifiable claim with a specific count, and it needs the same random-walk floor as everything else here — more touches means more exposure, so the naive version is trivially true.

**What a trendline break actually predicts (p. 68)** — and it is NOT a reversal:
> *"When a trend line is broken it should be taken seriously, but it typically signals only that the RATE OF CHANGE has slowed, and that the stock is likely to experience a CORRECTION THROUGH TIME."*

A directional prediction of *time*, not of *price*. Also *"touching a trend line does not give reason to buy or sell"* — same MTF discipline as levels: it nominates the area, the shorter timeframe decides. And *"a trend line is drawn to capture the essence of the trend, not to confine it to a rigid structure ... drawn with a crayon, not a ruler and pencil"* — i.e. tolerance bands, which is what `pivots_kernel` already does by smoothing before fitting.

**Two kinds of correction (pp. 62–65)** — a taxonomy `legs_classify` does not currently carry:
1. **PRICE correction** — moves against the primary trend ("pullback" in an uptrend, "snapback" in a downtrend).
2. **TIME correction** — *"the stock digests the move in a horizontal, low-volatility, trendless manner."*

Both are digestion; only one shows up as a retracement percentage. A pullback detector that only measures depth will score a time correction as "no pullback" and miss the setup entirely. Note this connects the trendline finding above: a trendline break predicts a *time* correction, which is exactly the kind a depth-based detector cannot see. `volatility_state` (the Crabel coils) is arguably the time-correction detector already — the two are the same phenomenon read through different tools.

**Timeframe mapping, stated explicitly (p. 61):** *"For short-term traders (1-10 days), the primary trend I refer to is found on the daily timeframe."* And p. 60: for an investor a 1–5 day move against the longer timeframe is *insignificant*; for a day trader it is the income. Same fact, opposite verdicts, decided by holding period — this is the `timeframe_plan` premise stated by the source.

**Arithmetic, not edge (p. 61):** *"In an uptrend, the sum of the rallies will always be greater than the sum of the declines."* Note "always" — this is definitional, the same category error as Crabel's contraction/expansion. It explains why trend-following is coherent; it is not evidence that it pays.

**A volume claim worth testing (p. 62):** *"The larger the volume on a break of longer consolidation levels, the greater the odds of a new trend being able to sustain the move."* `breakout_check` already measures volume on the break — this is independent support for that being one of the 5 measurements rather than decoration.

**Weakening-trend tells (pp. 66–67):**
- Volume weakening across *successive* trending campaigns (not bar to bar) — a campaign-level comparison, coarser than most volume filters.
- The time to re-emerge from a correction lengthening: *"The longer it takes for a move in the direction of the trend of the longer time frame, the less likely it is that the move will continue."* Time-based, and computable as bars-to-recovery per leg.
- His own caveat, twice: *"the only reason to take action of buying or selling comes from price action, volume aberrations are just clues to study price action more closely."*

**Late-trend hazard (p. 69):** *"some of the strongest trending moves develop near the tail end of a trend"* — the "bulletproof" perception, shorts chasing, then *"when emotions are high, volatility is generally close by."* This is the same trap as buying the 3rd/4th VCP base; it argues for reporting *where in the trend* a setup sits, not just that the trend exists.

**ch 9 opens** — volume is *"added second only to price."* Liquidity framed as market impact, and he is explicit that institutions sometimes force supply/demand to move price, i.e. some volume is intent rather than information. Level 2 / limit-vs-market-order material begins here — depth-tape territory, which `depth_get` covers and bar data cannot.

### s087–s102 (pp. 73–88) — ch 9 Volume, ch 10 Moving Averages opens

**Volume is a CONFIRMATION, never a trigger (p. 76)** — stated twice, unambiguously:
> *"Volume is used to confirm or reject price direction, NOT as a timing signal."*
> *"Don't wait for volume before making your purchases. The only thing that tells us when to buy is price action. If a stock you are watching for potential upside breaks past a level of what appears to be key resistance, it should be purchased as long as the stock is trading at least 'NORMAL' volume for the period being studied."*

The design consequence is concrete: a volume filter on a breakout should be a **floor at normal** (≥ ~1× average), not a requirement for expansion. His reason is a timing argument, not a statistical one — *"the volume they are waiting for to trigger their orders often will come AFTER the stock has already experienced a meaningful move."* Worth checking what threshold `breakout_check` and the morning screen actually use; if either demands 1.5–2× average it is applying a filter Shannon explicitly warns produces late entries. (This does NOT settle whether the filter pays — it identifies a parameter choice that has a source arguing both directions.)

And p. 80, blunter: *"do not fight a trend because of volume concerns."*

**effort_vs_result, in his words (pp. 76, 78)** — both directions, symmetric:
> *"Big volume without further upside progress indicates DISTRIBUTION."*
> *"Big volume without further downside is a sign of ACCUMULATION."*

That is exactly what `effort_vs_result` measures. Independent confirmation the tool is asking the right question. The churn definition is useful too: *"heavy trading activity without any directional movement."*

**Stage 2 volume signature (p. 75), with the entry it implies:** increasing volume as price expands, contracting volume on the correction *(either by price OR through time)*. *"This makes low-volume pullback stocks excellent candidates in which to establish new long positions."* Note the parenthetical again — the time correction counts as a correction for this purpose, so a low-volume *coil* qualifies the same way a low-volume *dip* does.

Stage 4 is the mirror (p. 77): expanding volume in the direction of the trend, contracting on counter-trend rallies. Plus a disqualifier for a short: *"If the stock rallies on heavier volume than it experienced as it declined, it could signal a change in the direction of trend that should ELIMINATE the stock from short sale consideration."*

**A caution against reading volume for permission to hold (p. 78):**
> *"Stocks can experience dramatic declines in a period where there is a simple absence of demand and moderate supply."*
> *"Whether a stock declines on low or heavy volume is not the point. ... Would you rather lose $10,000 on heavy volume or on light volume?"*

The failure mode is specific: low-volume decline is healthy in stage 2 and is a rationalisation in stage 4. Same measurement, opposite meaning, decided by the stage. Any volume rule that does not condition on trend state is reversible-by-context.

**Stage 1/3 volume — an explicit abstention (p. 79):** *"Volume patterns rarely add any value to a trend trader during these stages."* He names when his own tool is uninformative. Good model for a detector that should return `n/a` rather than a number.

**⚠️ The magnitude-from-duration claim (p. 80)** — the one Crabel-adjacent statement here we have NOT measured:
> *"Unusually large volume often precedes a volatility expansion, and high-volume breaks of support and resistance from LOW VOLATILITY levels typically will lead to a meaningful trending environment. The MAGNITUDE of an emerging new trend is MAGNIFIED BY THE LENGTH OF TIME the stock experienced consolidation. Longer periods of neutrality build more energy, and the larger a move will typically be when the stock breaks out."*

Our measured result kills the *direction* claim (narrow range → wider range: 76.4% real vs **80.2%** random, so real data shows LESS lift than noise). This is a different claim: **move magnitude ∝ consolidation duration**, conditional on a break. That is a regression, not a hit rate, and `volatility_state` + `breakout_check` already produce both variables. It needs the same random-walk control — a longer quiet stretch on a random walk also has more accumulated variance to release, so the null is not zero slope.

**Session-time volume, which supports the partial-bar guard (p. 80):**
> *"Trading volume outside of the normal hours (9:30-4:00 pm EST) tends to be very choppy."*

Independent support for `src/core/session.js` treating `volume` as `CORRUPTS_WHEN_PARTIAL`, and for the exchange-time (09:30 ET) bar convention rather than UTC.

Also (p. 80): liquidity is not constant even at millions of shares/day — it varies by time of year, time of day, proximity to earnings, and around technical levels. That is a direct argument for `trade_cost`/`turnover_cost` taking a liquidity input rather than a fixed bps.

**VWAP and the U-shape (pp. 81–85)** — mostly execution mechanics, but two structural facts:
- The intraday U-shaped volume curve is **self-reinforcing** because VWAP-based execution algorithms target a percentage of volume by time bucket. Figure 9.7 quantifies it: ~6.5% of the day's volume in the 09:30 bucket, trough ~2.4% around 12:45, ~6.5% again in the 15:45 bucket.
- Institutional order handling deliberately creates misleading prints — showing size on the offer while bidding in reserve to *"induce weaker holders to sell."* His word: *"This type of activity is pure manipulation, and it happens all the time."* So some volume is intent, not information. This is a limit on volume inference generally, and it is a depth/tape phenomenon `depth_get` sees and bar data cannot.

**⚠️ ch 10 inverts the moving-average convention (p. 88):**
> *"I also discourage the use of moving averages for systems. ... MOVING AVERAGE CROSSOVERS ARE ACTUALLY A SIGN OF INDECISION, WHICH IS A TIME TO BE OUT OF THE MARKET, versus trending action which should be acted upon."*
> *"If your interest is in developing moving average systems, consider adding a break above resistance or below support levels as a further filter."*

A crossover means the short and long averages are *equal* — i.e. no separation, no trend. Read that way the standard golden-cross system enters precisely at the moment of least directional information. This is a testable claim and it sits against a large body of trend-following work; the honest framing is that Shannon uses MAs as **reference points** (*"a visual reference point to which price can be compared"*), never as signals. Consistent with what we already did to Elder's rule in `mtf.js` after the Grimes measurement.

His actual usage: **three MAs per timeframe** — short, intermediate, long — because *"there are both minor and major trends on any given timeframe."* And he explicitly does not care SMA vs EMA: *"because we'll examine the moving average as a mere reference point ... there is no particular advantage to using one over another."* That matters for us — it means his 10/20/50 numbers carry no claim of optimality, so fitting them is not warranted.

### s103â€“s104, s113â€“s118 (pp. 89â€“90, 99â€“104) â€” ch 10 end, ch 11 Time & Timeframes, ch 12 opens
*(s105â€“s112 were read earlier in the session â€” pp. 91â€“98.)*

**Why a moving average works at all, in his account (p. 89)** â€” reflexivity, not prediction:
> *"There is no technical analysis voodoo for this tendency. Rather it becomes important because enough participants BELIEVE it to be significant, and their buying and selling actions based on that perception cause it to become a technical inflection point where value is often negotiated."*
> *"The real value of a moving average is the way in which participants RESPOND to price when a key moving average is tested."*

So the 50 DMA is load-bearing because it is watched, not because 50 is special. That has a testable consequence we could actually check: the effect should be strongest on the most-watched averages (50, 200) and absent on arbitrary ones (47, 193). If a 47-day MA works as well as the 50, the reflexivity story is wrong. Cheap to measure and nobody in this repo has.

Rule of thumb he gives: above a **rising** 50 DMA = bullish; below a **declining** 50 DMA = *"highly suspect and vulnerable to further decline."* The slope qualifier is doing the work, same as the ch-3 veto.

**FINDING â€” Figure 10.3: his timeframe-to-MA mapping is ROLE-based, not duration-based:**
> *"The daily chart on the left has a 50-day simple moving average, while the chart with 30-minute data on the right displays a 65-period (the market is open for 6.5 hours per day or 13 30-minute periods; over five days the market is open for 65 30-minute periods) simple moving average."*

His own arithmetic is right â€” 6.5h = **13** 30-min bars/day, 65 bars = **one week**. But a 50-day MA is ~10 weeks. Our `scaleTimeframe()` does *duration* equivalence (linear in bars): daily-to-30min is ratio 13, so a 50-day lookback maps to **650** 30-min bars, not 65. Shannon uses 65 because it fills the role of "the long reference average on this timeframe," which is a different design choice from preserving the lookback window.

Both are defensible and they are not the same thing. `timeframe.js` should say which one it implements â€” it scales *duration*, and anyone reading Shannon's 10/20/65 alongside 10/20/50 will assume the numbers correspond when they do not. Note his weekly triple is **10/20/40**, and 40 weeks is about 200 trading days, which *is* a duration match to the 200 DMA. So he mixes the two conventions himself. Confirms the 13-bars-per-day session figure independently (390 session minutes / 30).

---

**FINDING â€” Figure 11.1 / 12.1: THE TABLE. This is the book's spine, and it is a lookup table:**

| Trend | Use for | Investor | Swing trader | Day trader |
|---|---|---|---|---|
| **Primary** | Idea generation | Week | **Day** | 30 min |
| **Secondary** | Establish risk/reward | Day | **30 min** | 10/5 min |
| **Minor** | Fine-tune timing | 30 min | **10/5 min** | 2/1 min |

With the lookback windows he actually uses:
- Investor weekly: *"at least two years of data"*
- **Swing trader daily: "at least 150 days of data to get a good feel for the longer-term dominant trend"**
- **Swing trader 30-min: "20 to 30 days of trading activity"**
- **Swing trader 5/10-min: "five days for the 5-minute data and ten days for the 10-minute data"**
- Day trader: 30-min over 20â€“30 days; 5â€“10 min over the previous 5â€“10 days; 1/2-min over *"the preceding day or two"*

Every cell is a concrete parameter. This is directly checkable against what `timeframe_plan` and `mtf_analyze` return for a swing horizon â€” and the three ROLES are the useful part, because they are not interchangeable: long = idea generation, intermediate = **risk/reward and stop placement**, short = timing only. Assigning risk/reward to the wrong one is how a plan ends up with a stop that belongs to a different holding period.

**The three roles, stated as a rule (p. 101):**
> *"Using a minimum of three different timeframes for analysis aids three ways: identify the primary trend (long term), establish a risk/reward ratio using recent support and resistance levels (intermediate term), hone in on more accurate entries (short term)."*

And the division of labour (p. 99): *"the long-term timeframe is used for IDEA GENERATION, NOT FOR TIMING PURPOSES."* The short timeframe is where you *"make final timing decisions."*

**FINDING â€” the timeframe-justification trap, named by the source (p. 101):**
> *"For a day trader, analyzing the longer-term timeframes (such as weekly charts) will add little value â€” and may even DO HARM by allowing complacency to develop as you justify holding what was supposed to be a short-term trade based on longer-term trends."*

This is exactly the failure `mtf_analyze`'s `focus_timeframe_warning` was added for. Shannon states it as a hazard of looking at *too many* timeframes, which sits in real tension with his next bullet (*"the greater the number of timeframes you study to confirm the trend, the greater the probability that your trade will succeed"*). The resolution he offers is scope: *"learn to focus ONLY on the timeframes relevant to your objectives."* More timeframes **within** your band, not outside it.

**A claim to flag as unsupported (p. 101):**
> *"Decisions to buy or sell should be based on the shorter-term timeframes as they tend to LEAD the longer-term trends. The long-term trend is nothing more than the sum of the shorter-term trends, so the short-term trends lead the longer-term trends."*

The premise is an identity (aggregation) and the conclusion is a causal/predictive claim. That a daily bar is *composed of* 30-minute bars does not make 30-minute structure predictive of daily structure â€” by the same logic every tick leads everything. Same category slip as "the sum of the rallies exceeds the sum of the declines." It matters because it is the stated justification for entering on the short timeframe, and the actual justification is the sound one he gives elsewhere: a shorter timeframe gives a **tighter stop**, hence lower risk per unit â€” *"the greatest value to shorter-term analysis is the reduction of risk by capturing more accurate entries and managing stops."* That is a risk argument, not a forecasting one, and it survives.

**Abstain on disagreement (p. 101):** *"when there are mixed trend signals across various timeframes, it is best to revert to a more cautious mode until trends begin to align and show lower-risk entries."* Matches `mtf.js` returning `context_ranging` rather than a lean.

**Against a hard index veto (p. 102):** *"There are times in both bull and bear markets where some individual stocks will become immune to overall market strength and weakness... In nasty bear markets there are winners, and in strong bull markets there will be losers. Focus on the trends of the stock you are trading, not on a relationship which is 'supposed to be present.'"* Argues the regime should size, not forbid â€” which is what `ta_regime` already does.

---

**ch 12 â€” the long-side screen, as clauses (p. 104):**
> *"The first consideration for a stock to trade to the long side is that it must be in a Stage two uptrend on the daily timeframe."*
> *"The best candidates are those stocks that are trading above the rising 10-, 20- and 50-day moving averages, with the moving averages STACKED above each other 10>20>50. Consider it a bonus if the stock is above all of the rising key (10, 20, 40) moving averages on the WEEKLY timeframe."*

So the entry filter is five clauses, each computable: (1) stage 2 on daily; (2) price above all three; (3) all three **rising**; (4) stacked 10 above 20 above 50; (5) *bonus* â€” weekly 10/20/40 also rising and price above. Worth comparing against the morning screen's current trend gate, and note the stack ordering is a separate clause from the slopes â€” a stock can have all three rising while still crossed.

His own caveat on the weekly clause, which is the horizon problem again: *"note that for a short-term trader, by the time the trends of the weekly timeframe become relevant, it is likely the trade may have been exited."*

Also (p. 103): *"For a trend trader, the only stocks which should be of ANY interest are those in an established Stage 2 Uptrend or a Stage 4 Decline."* Stage 1 and 3 are not tradeable for him at all â€” an explicit universe restriction, and the reason his stage classifier needs to be able to say "neither."


### s119â€“s126 (pp. 105â€“112) â€” ch 12: the operational core of the book

**FINDING â€” the four-stage ACTION state machine on the short timeframe.** This is the most implementable thing in Shannon and we have no equivalent. Precondition: the **daily** is Stage 2. Then the **10-minute** stage dictates the action:

| Short-TF stage | Action | Trigger / rule |
|---|---|---|
| **1 â€” ANTICIPATE** | Stalk, do not buy | *"the observation of Stage 1 accumulation on the 10-minute timeframe is the time to be on high alert for buyers to regain control of the short-term trend"* â€” set an alert, load orders. *"no action should be taken to get long until the stock begins to move higher on the shorter timeframes"* |
| **2 â€” PARTICIPATE** | **Buy** | *"Once the stock has broken past the short-term level of resistance and has established a HIGHER HIGH, it is time to buy!"* |
| **3 â€” EXIT** | Sell the remainder | price correction: *"if the stock violates the previous higher low on the 10-minute timeframe, the short-term trend becomes invalidated. I view that as my cue to exit any remaining long shares"*; time correction: *"when the 10-minute timeframe shows the first signs of indecision (short-term moving average crossing BELOW intermediate-term moving average), I exit any remaining shares"* |
| **4 â€” AVOID** | Stay out entirely | *"consider it a bear market for the short-term trader, and avoid the stock"* |

The two Stage-3 triggers are the two correction types from ch 8, each with its own detector â€” a price trigger (broken higher low) and a *time* trigger (MA cross). That is the first place in the book where the MA crossover has a job, and it is an **exit** for indecision, consistent with p. 88's claim that a crossover means indecision rather than direction.

Hold rule, stated as a negative: *"As long as the stock continues to establish a pattern of higher highs and higher lows on the 10-minute timeframe, there is no reason to exit."*

**Stop rules â€” three of them, all concrete:**
1. Initial: *"The most sensible stop for a new long position is one that is simply based on the definition of a long trend -- 'higher highs and higher lows.'"* Placed below the most recent higher low on the intermediate timeframe.
2. *"it is a mistake to base long stops on anything other than ACTUAL LEVELS OF PRIOR SUPPORT"* â€” no ATR-multiple, no percentage.
3. Trailing: *"As the stock recovers from the short-term corrections, the low of the correction serves as the location of the new stop. The process of raising stops is continued until the stock trades to a lower low on this timeframe or until the moving averages cross and show indecision."*

And the line that defines the whole method: *"Once the definition of trend is invalidated and you continue to hold the stock, you are no longer a trend trader."* Also *"stops are of no value if you do not take action"*, and a list of the excuses that defer it â€” including *"Don't pay attention to the volume ... These excuses are your way of not admitting defeat."*

Note (3) is a **trail**, so `stopping_premium` applies directly: a trail is a bet on persistence, and on 9 of 12 of the user's real holdings we measured no persistence. Shannon's trail is not an edge claim, it is a definition-of-trend claim â€” the stop moves to where the trend definition would break. That is a cleaner justification than "protect profits" and it is worth keeping the distinction when this gets implemented.

**FINDING â€” a concrete alert-placement rule (p. 109), which we can use immediately:**
> *"If I think the stock will break resistance at a literal number such as 25.30, I will set my alert for 25.26 or some other number just below the key level. Being alerted to the stock as it gets close to a breakout assures that I will have my eyes on the trading activity just before a break into an uptrend. If I wait for the breakout to occur before I begin to watch the stock closely and do not have orders loaded to buy, I may end up being late and have to chase the stock higher."*

Alert goes **just below** the level, not at it â€” ~4 cents on a $25 stock, i.e. roughly 15bps. `alert_create` currently checks only that the price is on the correct side of spot. An offset-below-the-level convention (and a warning when an alert is placed exactly *at* a drawn level) matches how the alert is actually meant to be used.

**Scale-out, and it is not the same as the stop (p. 110):**
> *"After an initial short-term burst of buying activity, I typically exit a small portion of my position. I may decide to exit ONE-FOURTH TO ONE-THIRD of my position on the first thrust higher ... If the unfolding short-term uptrend rally fails and then reverses, the small realized profits assure I will not lose money on the trade if I move my stop to BREAKEVEN on the balance."*

Then a second tranche as price targets are met, with an execution reason rather than a psychological one: *"If there is truly resistance to be found at my target, selling a portion of the stock allows me to book profits while there is still sufficient liquidity to exit. In addition, my selling doesn't push the stock lower."* Market-impact logic â€” consistent with ch 9.

He rejects the standard aphorism explicitly: *"I have heard people say that 'winners take care of themselves,' and I do not agree with it. ... the stock needs to be managed AGGRESSIVELY."*

**The worked example, with its arithmetic (Figures 12.2, 12.3):**
- Daily: rising 10/20/50, recent support at the 10- and 20-day forms the higher low where the initial stop goes. Near new highs, so *"our minimum upside target would be 44.50 (a conservative target which assumes a slight movement into new high territory)."*
- 30-min: break of resistance near **42.50**, most recent higher low near **41.80** â†’ *"our risk would be 70 cents versus our anticipated reward of 2.00."* That is **2.9:1**, against the 3:1 gate on p. 58 â€” so his own worked example is marginally *below* his stated threshold. Worth noting rather than smoothing over.
- 30-min window here is *"15 to 20 days of data"* â€” ch 11 said 20â€“30. He is not precise about it; do not treat either number as tuned.

**Why the intermediate timeframe is not optional (p. 107):**
> *"A large-volume consolidation that, for example, lasted for four hours before the stock broke down will not show as a potential resistance level if you are looking solely at a daily timeframe ... a prior significant level of trading that may not be visible on the longer timeframe may become a point where future supply is released to the market and upward momentum is interrupted."*

Intraday levels are invisible to a daily-bar level finder, and they are what caps the *target*. `levels_find` on daily bars structurally cannot see these. That is a real limitation to state, not a bug to fix â€” it needs intraday data.

**Don't wait for volume on the entry bar (p. 110)** â€” third time he says it, now specifically about the trigger:
> *"it is a common mistake to wait for volume to confirm price activity of the higher high on the short-term timeframe; LARGE-VOLUME LEVELS WILL NOT YET BE PRESENT as trading activity typically increases AFTER prices have experienced short term price movement."*

**No averaging down, stated as a rule (p. 112):**
> *"Instead of attempting to 'scale in' or 'average down,' a long candidate should be allowed to experience the full short-term Stage 4 decline on the 10-minute timeframe before it is even considered a long candidate. We never know if a stock will find support and then bounce; buying into a short-term decline puts you in an immediate and unnecessary losing position."*

Directional conflict between timeframes = **do not enter**, not enter smaller.

**A testable claim worth flagging (p. 112):** *"news and surprises tend to follow the primary trend,"* his reason being that a longer-term uptrend *"favors the likelihood of a fundamentally solid company where good news is often released."* That is adjacent to PEAD and to the momentum literature, and it is checkable against TA's earnings data. Remember what we already know: PEAD **dissolves at the firm level** â€” 16% of good-news quarters drift negative â€” so the portfolio version of this may hold while the single-symbol version does not.

**On shorting inside an uptrend (p. 112):** possible but *"the risks are much higher than shorting a stock where the primary trend is lower,"* with the arithmetic reason (sum of declines < sum of rallies in an uptrend) plus the news asymmetry above. Consistent with the ch-6 asymmetry.

**Why cash is a position (p. 109):**
> *"Just as moving average crossovers represent indecision on one particular timeframe, the lack of aligned trends shows us a lack of consensus among participants of varying timeframes. This lack of consensus creates conflicting trends on various timeframes that DIMINISHES THE ODDS OF A SUSTAINABLE TRADABLE MOVE. In other words, if timeframes aren't aligned, being in cash gives us the ability to maintain an objective look at the stock."*

He also keeps exited names on a watchlist checked *"two to three times per day"* â€” the short-term distribution *"indicates a minimum of further time consolidation, but it often leads to a deeper price correction."* An exit is a demotion to a watchlist, not a deletion; that is what the KEEP section in our watchlist rewrite is for.


### s127â€“s142 (pp. 113â€“128) â€” ch 12 examples, ch 13 How & When to Sell Short

**FINDING â€” a computable bear-market definition (p. 117):**
> *"Many people consider a ten percent or greater broad market decline to be an official bear market, but I consider that to be too loose of a definition. ... The best way to define a bear market is an environment in which markets where the 200-day MA is DECLINING."*

A slope test on the 200 DMA, not a drawdown threshold. Figure 13.1 uses the **40-week** MA and states outright it is the 200-day â€” so on weekly bars he *does* do duration equivalence. Directly comparable to what `market_regime` / `ta_regime` currently use.

**FINDING â€” a numeric capitulation / short-candidate filter (p. 118):**
> *"Fear of the longs often shows its first signs as the stock experiences an unusually large drop on huge volume -- loosely defined as at least FIVE TIMES larger than the average trading volume of the LAST 20 DAYS. When stocks are 'thrown away' all at once on large volume, it signals a shift in the perception of the participants. Often the catalyst for such a move is a fundamental event. These stocks become potential shorting candidates and they are worth keeping an eye on over the NEXT SEVERAL MONTHS while stubborn longs continue to sell their positions out of frustration."*

5Ã— the 20-day average volume, and a *months*-long watch window afterwards. Note this is the one place he gives an explicit volume-expansion threshold â€” and it is for identifying a **regime change in a name**, not for confirming an entry. Consistent with his "volume confirms, never triggers" rule.

**The short screen â€” mirror of the long one (p. 120), with the weekly demoted explicitly:**
> *"The best candidates are those stocks which are trading below the declining 10-, 20- and 50-day moving averages, with the moving averages stacked below each other 10<20<50. It is a better setup if the stock is also below the key moving averages on the longer term (weekly) timeframe, but DO NOT EXCLUDE a stock from being a swing trade candidate because of the trends on the weekly timeframe. By the time the trends of the weekly timeframe become relevant, it is likely the trade will be exited."*

So on both sides the weekly is a **bonus clause, never a filter** â€” stated twice, for the same horizon reason. If our screen gates on weekly trend it is stricter than the source it comes from.

Plus a sector clause: *"we ideally want the overall market, the sector AND the stock to be in a decline ... When there is broad weakness in a sector, it greatly mitigates the risk that the decline in a stock is a one-time, short-lived problem specific to one company's stock."* Three-level alignment; `relative_strength` and `position_correlation` are the tools that speak to this.

**The short-side state machine (pp. 123â€“127)** â€” same four states, rotated by two:

| 10-min stage | Action | Trigger |
|---|---|---|
| **3 â€” ANTICIPATE** | Stalk | *"When a stock in a primary (daily) downtrend is being distributed on a 10-minute timeframe, it is the most likely time to begin a new leg lower."* Watch for *"increased volume, LOWER HIGHS and MORE FREQUENT TESTS of short-term support"* |
| **4 â€” PARTICIPATE** | Sell short | *"Once the stock has broken below the short-term level of support from the distribution and has established a LOWER LOW, it is time to sell the stock."* |
| **1 â€” EXIT** | Cover remainder | price: violates the previous lower high on 10-min; time: short-term MA crossing **above** intermediate-term MA |
| **2 â€” AVOID** | Stay out | *"A short-term Stage 2 in a primary Stage 4 stock should be avoided ... Fighting even a two- to three-day trend exposes your equity to unnecessary risk."* |

The "more frequent tests" clause is the aggression-in-time measure from Figure 7.4, now on the short side. Both sides of the absorption rule are stated, which makes it a symmetric, testable pair.

**âš ï¸ His own worked examples both sit BELOW his stated 3:1 gate.** Worth recording rather than smoothing:
- Long, Figure 12.3: risk 0.70 (42.50 entry, 41.80 stop), reward 2.00 â†’ **2.9:1**
- Long, Figure 12.5: entry past 25.60, stop below 25.00, target 27.00+ â†’ **~2.3:1**
- Short, Figure 13.3: stop just above 73.50 â†’ **1.80 risk/share**; target the recent low near 67.00 â†’ 4.50 â†’ he writes *"the risk/reward ratio of 1:2.5 would be acceptable to justify a short trade."*

So the operative threshold in practice is ~2.5:1, not the 3:1 stated on p. 58. If a 3:1 gate goes into `rules.json` on Shannon's authority it would reject his own examples. Also note he takes the **prior low** as the target rather than a projected lower low, and calls that the *conservative* choice: *"Because we use the prior low as a target instead of a lower low, the risk/reward ratio of 1:2.5 would be acceptable."* That is a deliberate conservatism in the target, which is the opposite of how `fib_targets` extensions are usually used.

**Confirms the role-based intraday MA convention.** Figure 13.3: *"a declining 65 period (5-day) moving average"* on 30-min. Figure 13.6: *"the declining 195 period (5-day) moving average"* on 10-min. Check: 30-min â†’ 13 bars/day Ã— 5 = 65. 10-min â†’ 39 bars/day Ã— 5 = 195. Both correct, and both are **one week**. So his longest intraday reference average is always a week, regardless of bar size â€” a *role* constant, not a duration match to the 50 DMA. Independent confirmation of the 390-minute session (39 Ã— 10 = 390).

**The stop trail, short side (pp. 123, 125):** *"As new lows are established, the stop on the remaining shares should be methodically lowered to a level just above the preceding high."* And a hard rule against widening: *"Be quick to take your losses if a buy stop is hit, and do not make the mistake of canceling your order and reassessing risk levels. ... The ONLY time stops should be changed on short trades is when the market moves in your favor and you are reducing risk."* A one-directional ratchet. That is exactly the invariant a stop-management tool should enforce and is easy to get wrong.

**Scale-out is symmetric (p. 125):** *"After a quick short-term sell off, I typically exit a small portion of my position on the first decline â€“ as much as one-fourth to one-third of the total"*, then stop to breakeven on the balance, then a further tranche as targets are met â€” again with the market-impact reason (*"without my buying pushing the stock higher"*).

**Two news claims worth flagging (pp. 124, 126):**
> *"news and surprises tend to follow the direction of the trend, and news also tends to be released towards the END of a short-term move."*
> *"smart money covers on the bad news. When widely anticipated news is released and the stock drops sharply, who is left to sell?"* â€” *"bad news often comes out at bottoms."*

The second is the more interesting one and it is checkable against TA's earnings data: it predicts that a sharp gap down on *anticipated* bad news marks exhaustion rather than continuation. That is a direct contradiction of naive PEAD-style continuation, and it is the same asymmetry we already have in the gap-classification work. Neither is measured here.

**Execution: the leading limit order (p. 124)** â€” depth-walking arithmetic, worked:
> current bid 500 @ 25.50, 300 @ 25.48, 600 @ 25.47, 200 @ 25.45. Sell short 2,000 with a limit of **25.45** â†’ clears 1,600 shares of resting liquidity down to 25.45, and the remaining 400 becomes the best offer.

This is exactly what `depth_get` sees and what `trade_cost` estimates by proxy. His stated second motive is reflexive: *"my aggressive action at a key level may further influence other participants to pull their bids."* He always uses limit orders to enter a short, never market.

**Miscellaneous, kept because they are quotable and honest:**
- *"Only liars buy the exact low, focus on making smart trading decisions, not on picking highs and lows."* (Fig. 13.6, immediately after showing his own stop being hit ~5 points *past* the conservative target â€” i.e. the technique giving back gains.)
- *"from failed moves come fast moves"* (Fig. 13.5) â€” a failed break below a declining 50 DMA leaving the stock vulnerable.
- Bear markets *"occur every 39 months on average and ... typically last for about 18 months"* â€” he flags it himself: *"I have done no independent verification of studies."* Treat as folklore, not data.
- *"you should be much CHOOSIER for short trading candidates than a corresponding long"* + *"Smaller share size in bear markets"* + *"keep overall trading activity low relative to your trading volume in a bull market."* Three separate asymmetries: selectivity, size, and turnover. Consistent with the ch-6 hold-period asymmetry.
- Short squeezes: *"Some of the sharpest rallies experienced by stocks occur during a downtrend"*, and *"Liquidity can become thin in a squeeze environment, and large share size makes it very difficult to exit a position without creating a negative market impact cost."* Liquidity risk and direction risk compound on the short side.
- *"Bear markets are characterized by a stronger emotional response than bull markets because people are complacent when they are winning and become frightened when they are losing."* The stated mechanism behind faster declines â€” testable as a vol asymmetry, and well documented elsewhere (the leverage effect).


### s143â€“s158 (pp. 129â€“144) â€” ch 14 News, ch 15 The Short Squeeze

**ch 14 opens by bounding itself:** *"95 percent of this book is dedicated to technical analysis, and the other five percent to this chapter. All of my timing decisions are based on price, not news or fundamentals."* And the summary line: *"Think like a fundamentalist, and trade like a technician."*

**FINDING â€” flat into earnings, stated as the rule (p. 134):**
> *"While it is true that news and surprises tend to follow the direction of the trend, there are the occasional land mines in the market that can be avoided by reducing exposure before such an important event. The most obvious thing to do is to find out when a company is due to report earnings and then MAKE SURE THAT YOU ARE NOT HOLDING A STOCK POSITION AHEAD OF THE REPORT."*

Unambiguous, and it is what `ta_trading_context` / `ta_earnings` / the `catalyst-aware-brief` exist to enable. Note it sits in tension with his own "news follows the trend" claim â€” he resolves it as asymmetric loss, not as a forecast.

**FINDING â€” a four-way post-news taxonomy (p. 132).** This is a classifier we do not have, and every branch is computable from bars:
1. **Fizzle out** â€” the reaction dies, the stock enters a period of inactivity. *"avoid these stocks."*
2. **Create a new trending environment** â€” *"If a stock breaks out of a longer-term consolidation after a news release, there is a high likelihood that the new trend will be able to sustain the move, particularly if the breakout is accompanied by a surge in trading volume."*
3. **Accelerate an existing trend** â€” news as fuel for a trend already in place.
4. **Reverse the prevailing trend** â€” *"Occasionally a true surprise catches a large group of participants off guard, and sentiment changes so drastically that the stock may reverse."*

Branch 2 is the only one he assigns a high likelihood to, and it carries two preconditions: a *longer-term consolidation* being broken, and a *volume surge*. That is the one place he wants volume expansion on a break â€” and it is exactly the `volatility_state` + `breakout_check` + event-date combination we already have the pieces for.

**A pre-event drift test that contradicts naive continuation (p. 131):**
> *"Does it look like the information was 'priced into the market' prior to the release? If the stock made a SIGNIFICANT MOVE IN THE DAYS BEFORE the news report, there is a good chance that the MOVE WILL FAIL, as the participants who anticipated the event will take advantage of news hype to liquidate their position and thereby extinguish the trend."*

Computable: pre-event drift over N days â†’ predicts post-event *failure*, not drift continuation. Paired with *"smart money covers on the bad news"* and *"bad news often comes out at bottoms"* from ch 13, Shannon's news model is **exhaustion-on-the-anticipated, continuation-on-the-surprise**. That is a testable split of PEAD by whether the move preceded the print, and it is checkable against TA's earnings history. Also worth doing per symbol: *"Is there a pattern to how the stock has acted when similar news was released? A good example of this would be quarterly earnings reports."*

**Regime-conditional news response (p. 131)** â€” asymmetric, and measurable:
> *"It is common for strong markets to ignore negative news ('climb a wall of worry'), while weak markets react quickly and severely. Bear markets tend to ignore positive news and slide down a 'slope of hope' or react with limited enthusiasm."*

So the same headline has a different price consequence depending on `market_regime`. If true, an event study that pools across regimes averages two opposite effects.

**Calendar facts (pp. 133â€“136):** earnings warnings begin *"two to three weeks before the actual results"*; results typically 1â€“6 weeks after quarter end; US government economic reports at **8:30 a.m. ET**; FOMC **eight** scheduled meetings a year, minutes **three weeks** after the decision. (His *"2:15 p.m. Eastern"* FOMC time is dated â€” it has been 2:00 p.m. ET since 2013.) Other single-stock catalysts he lists: annual meetings, splits, buybacks, analyst revisions, conferences, FDA reports, insider transactions.

Two lines worth keeping: *"professionals anticipate while amateurs react"*, and *"if there is no price clarity, cash is your best position until a low-risk action point reveals itself."*

---

### ch 15 â€” THE SPEC FOR THE FINRA SHORT-INTEREST WORK

**Definition (p. 139):**
> *"The Short Interest Ratio (SIR), or days to cover, is the number of shares sold short (short interest) for a particular stock, divided by its average daily volume over the PREVIOUS TWO WEEKS."*

His worked examples: 4,800,000 short / 800,000 ADV = **6.0**; same short at 2.4M ADV = **2.0**; same short at 200,000 ADV = **24**.

**Publication cadence (p. 143):**
> *"Twice each month, the firms tally all short sales not covered by their customers and send the data to the various exchanges. The exchanges then combine the firm data and publicly disseminate the information on the 15th and last calendar day of each month."*

For our purposes: this is **bi-monthly, lagged** data, so the same `age_hours` discipline applies as to TA's walls. A SIR quoted without its as-of date is close to meaningless.

**FINDING â€” Figure 15.1 is the table schema to build.** Five columns, plus he adds a sixth himself:

| Date | Short Interest | Avg Volume | S.I.R. | VWAP |
|---|---|---|---|---|
| 2/29 | 21,275,047 | 2,651,156 | 8.02 | 17.68 |
| 2/15 | 19,867,817 | 2,559,249 | 7.76 | 18.52 |
| 1/31 | 17,871,618 | 4,345,058 | 4.11 | 20.91 |
| 1/15 | 19,007,950 | 2,866,400 | 6.63 | 23.36 |
| 12/31 | 19,276,055 | 1,492,816 | 12.91 | 27.24 |
| 12/14 | 17,035,558 | 1,886,753 | 9.02 | 29.90 |
| 11/30 | 17,776,362 | 2,426,715 | 7.32 | 29.36 |
| 11/15 | 13,937,413 | 1,852,338 | 7.52 | 32.90 |
| 10/31 | 12,091,492 | 1,660,065 | 7.28 | 34.88 |
| 10/15 | 11,670,909 | 1,195,727 | 9.76 | â€” |

The **VWAP column is his own addition** and it is the clever part: *"Average price at which the stock traded during the prior period, it offers an idea of the average price at which SHORT SELLERS MAY BE INVOLVED."* It estimates the shorts' cost basis per accumulation period. Current price vs that VWAP tells you whether the shorts are in profit â€” which is the whole mechanism behind whether they are forced to cover. We can compute per-period VWAP from bars we already have; the only missing input is the short interest itself.

**âš ï¸ A caveat this table demonstrates and Shannon does not name: SIR conflates its numerator and denominator.** Compare 12/31 and 1/31 â€” short interest barely moved (19.28M â†’ 17.87M, âˆ’7%) but SIR collapsed from **12.91 to 4.11** (âˆ’68%), entirely because average volume tripled (1.49M â†’ 4.35M). A "days to cover" reading that fell by two-thirds while the short position was essentially unchanged is not a change in short conviction; it is a change in liquidity. Any short-interest tool here must report **raw short interest, ADV, SIR, and short % of float separately**, and never let SIR stand alone. This is the same failure shape as the hysteresis-percentile bug fixed earlier this session: a ratio moving because its denominator moved.

His own reading of the series (p. 144) tracks the numerator, correctly: *"as the stock broke down, the short sellers became more aggressive, raising their bet against the stock from 11.6 million shares to 21.2 million. During period 7 on the chart you can see that the large volatility motivated shorts to cover approximately 1.2 million shares. As the stock continued lower, the shorts added even more shares."*

**âš ï¸ The load-bearing caution (p. 140) â€” do not build a squeeze screen on SIR alone:**
> *"It is important to note that a large outstanding short position or short interest ratio BY ITSELF IS NOT A REASON for buying a stock in anticipation of a short squeeze. The informed trader will find an edge when there is a preponderance of indicators leading to a price advance. Nonetheless, it is an EXCELLENT GAUGE OF POTENTIAL DEMAND for a stock which should be a part of every trader's arsenal."*

So the correct role for short interest in this toolkit is a **context field**, like `ta_trading_context` â€” potential demand attached to a setup found some other way, never a signal on its own. That is precisely how it should be wired.

And the reason it is potential *demand*: *"sellers represent future demand for the stock because they must repurchase shares they sold short at some future date."*

**Squeeze type #1 â€” the knee-jerk emotional squeeze (pp. 141â€“142), and he tells you not to trade it:**
> *"When a stock in an established Stage 4 decline is accompanied by a large short position, short sellers are in control of the trend, and their accumulated profits make them less likely to panic and buy at the first signs of strength."*
> *"Stage 4 stocks can experience quick and large rallies, but those short-term bursts higher typically will FAIL as longer-term selling pressure is too strong to overcome."*
> *"because the dominant trend of the longer timeframe is lower, they are very risky trades. They are best left to the most risk-tolerant traders who specialize in the shortest timeframes. The best course of action is to STAY WITH THE PRIMARY TREND rather than charter these risky waters."*

The mechanism he describes is a supply-absorption sequence, same shape as Figure 7.4: a relentless selling campaign exhausts sellers â†’ *"a simple absence of further supply"* pushes shorts to cover â†’ limited supply forces price up â†’ sidelined cash chases â†’ shorts and longs compete for limited shares. Note the profit-cushion clause is a real asymmetry: shorts sitting on gains do **not** panic, so a large short position in a *declining* stock is not squeeze fuel. Squeeze fuel is a large short position where the shorts are **underwater** â€” which is exactly what the VWAP column measures.

**Forced buy-ins â€” two mechanisms (pp. 140â€“141):** margin calls, and shares no longer available to borrow (recalled by the lending long holder, leaving a naked position the broker must close). Plus the deliberate version: *"If large long holders wish to inflict maximum damage on short sellers, they will allow their stock to be borrowed until a time where the buyers have taken control of the trend"* and then demand delivery. Also a defensive trick for the long side, worth knowing: enter a **GTC sell order at an unreachable price** (stock at $20, GTC sell at $50) â€” a pending liquidation order prevents the broker lending your shares.

**Do not short on valuation (p. 138):** *"Unless you want to become the victim of a short squeeze, do not sell short when you think a stock 'is up too much,' the 'P/E is too high' or any other subjective reason."* And on the shorts themselves: *"Short sellers who initiate large positions against a stock typically are sophisticated speculators who have done extensive research ... Many times those who sell short have the right idea fundamentally, but their timing is off."*


### s163â€“s174, s183â€“s198 (pp. 149â€“184) â€” ch 16 Risk, ch 17 rules, ch 18 Putting It All Together
*(s159â€“s162 and s175â€“s182 were read earlier in the session.)*
**BOOK COMPLETE â€” all 99 two-up spreads read, pp. iâ€“184.**

---

**FINDING â€” three position-size constraints, and the binding one is not always the risk budget (pp. 153â€“154).** This is the most useful thing in ch 16 and it is a worked demonstration that a 1%-risk formula alone is unsafe:

1. **Risk budget** â€” *"A commonly used percentage is approximately one percent of trading capital"*, recomputed off the NEW balance each time: lose on the first trade â†’ $99,000 â†’ *"you should not risk more than one percent of THAT capital, or $990"*; win â†’ $110,000 â†’ $1,100. General rule: *"you never want to risk more than one to two percent of your overall capital on any trade."*
2. **Concentration cap** â€” *"exposing more than 15 to 20 PERCENT of your account equity to any ONE POSITION can result in disastrous effects on your account balance if something unexpected goes wrong."*
3. **Liquidity** â€” the position must be exitable in the name's actual volume.

His worked example shows (1) and (2) colliding: $50 stock, stop just below support at 49.25 â†’ **$0.75 risk/share**; target 52.25 â†’ 3:1, acceptable. $1,000 / 0.75 = **1,333 shares** â‰ˆ **$66,650** on a $100,000 account. His own comment: *"But would you really want to commit **65%** of your trading capital to just one idea?"*

A tight stop *inflates* share count under a fixed-risk rule, so the tighter the stop the more likely the concentration cap binds. Second example shows (3) binding: $2.50 stock, support 2.35 (0.15 away), target 3.00 â†’ better than 4:1; $1,000/0.15 = **6,666 shares** â€” but *"what if the average volume for this stock was just 300,000 shares per day?"*

**Action: check that `position_size` / `position_size_atr` report all three constraints and return the MINIMUM, not just the risk-derived share count.** `position_concentration` exists and knows the 15â€“20% figure's shape; the two need to be one answer, because a caller who only sees the risk number gets the 65% position. This is the same failure class as the SIR-denominator problem and the hysteresis-percentile bug: a single ratio quoted without the constraint that actually binds.

Loss-recovery arithmetic he tabulates (p. 153): lose 10% â†’ need **11%**; 20% â†’ **25%**; 50% â†’ **100%**.

**FINDING â€” the seven exit events (p. 157).** Compare to `EXIT_REASONS` in [src/core/exits.js](../../src/core/exits.js), which is Bellafiore's ten:

| # | Shannon's event | Maps to |
|---|---|---|
| 1 | Initial protective stops | `stop_hit` |
| 2 | **Gaps against the prevailing trend** | *no equivalent* â€” see below |
| 3 | Price targets | `target_hit` |
| 4 | **Hard trailing stops** (trend-definition based) | `trend_broken` |
| 5 | Trailing stops | `too_much_pullback` |
| 6 | Time stops | `time_elapsed` |
| 7 | **Moving average crossovers** | *no equivalent* â€” the time-correction exit |

Two Shannon exits have no Bellafiore counterpart, and both are **planned and modellable**, which makes them worth adding: the gap-against-trend exit and the MA-crossover exit. That is a small, concrete addition to a taxonomy we already ship.

**The â‰¥5% gap rule, now with its base rate (p. 157):**
> *"These dramatic gaps, normally more than FIVE PERCENT (versus more common gaps of ONE TO TWO PERCENT), occur when a stock in an uptrend suddenly gaps lower while you have a long position. Luckily, these gaps in trading, caused by an imbalance to the sell side while the stock is in a solid uptrend, are NOT ALL THAT COMMON. When, however, we are caught in this predicament, it is often best to sell the ENTIRE position. A gap of this magnitude typically will not occur unless there is a serious fundamental development at the company, and because our entry may not have taken fundamentals into consideration, we are now in an unanticipated position."*

This is the third time the 5% figure appears (ch 4 as trend invalidation, ch 6 as the short-side asymmetry, here as an exit). It is his one hard numeric threshold and it is consistent across all three uses. Note the reasoning is an **information** argument, not a technical one â€” a 5% adverse gap means fundamentals moved and the chart-based thesis no longer has standing. He adds the follow-through claim: *"Stocks which break severely from trend rarely recover fully, and it is best just to move on."* `gap_risk` already computes gap magnitude; the 5%/1â€“2% split is a documented threshold to attach to it.

**The hard trailing stop, specified precisely (Figures 16.4, 16.5):**
> Long: *"the trailing stop is raised to a level just below the higher low (even numbers) after the stock establishes new highs (odd numbers). For example, as the stock clears point 5, the stop is raised from point 4 to point 6. This process is repeated until the stock establishes a lower low."*
> Short: *"the stop is lowered to a level just above the lower highs (even numbers) after the stock establishes new lows (odd numbers)."*

Fully algorithmic off swing pivots: a new confirmed higher high *promotes* the stop to the most recent higher low. `structure_analyze` already produces the pivot sequence, so this is implementable exactly as stated â€” and it is a *pivot* trail, not an ATR or percentage trail, which matters because `stopping_premium` measures persistence and this trail's justification is definitional (*"breaking the series of higher lows is a violation of the trend"*) rather than an edge claim.

**Time-based stops (p. 151):** *"If the anticipated market activity has not occurred within a specific amount of time, then liquidate most, if not all, of your position."* He gives no number for swings â€” *"There are no hard and fast rules here"* â€” but for a day trade it is the session close. This is the third barrier, and he lists the inputs that should set it: *"personal objectives, knowledge of the situation, capital availability, mental concentration, position size and opportunity cost."*

**Overnight rule (p. 151):** *"For short-term traders, though, only hold stocks overnight where you ALREADY HAVE A PROFIT. If you have a losing position, liquidate it by the end of the day, and start fresh the next morning."* Repeated at p. 178: *"If I find myself in a losing position near the end of the day, I almost always sell it out."* Combined with a reason to hold winners: *"an opportunity to cash in on continued profits at the expense of those who miss out on the previous day's action and then chase a stock on the open."*

**Win rate is not the measure (pp. 151â€“152)**, with real data. Figure 16.2 is his own broker "Trade Evaluator" output over 1/1â€“1/21, and it is a good template for what a journal review should slice by:

| Slice | Trades | %Gainers | Avg trade |
|---|---|---|---|
| Long | 256 | 52.0% | 17.68 |
| Short | 101 | **56.4%** | 14.83 |
| Share price >$100 | 159 | 47.2% | **âˆ’3.82** |
| Share price $10.01â€“25 | 52 | 63.5% | 14.82 |
| 751â€“1000 shares | 107 | 46.7% | 0.94 |
| 16â€“30 min held | 44 | 50.0% | **âˆ’17.93** |
| >120 min held | 5 | 60.0% | 140.56 |

Two of his slices are net **negative** (stocks over $100; trades held 16â€“30 minutes) while the book was profitable overall â€” exactly the kind of finding a journal exists to surface, and it is invisible in an aggregate win rate. His short win rate was *higher* than his long. And: *"I have had extremely profitable months when my winning ratio was just 45 percent."* Plus the ego diagnosis: *"Traders who brag about their 80 percent or higher win/loss ratios may still manage to lose money on balance because these high percentages are achieved by doing the exact OPPOSITE of what is right â€“ selling winners very quickly and holding on to losers."*

Slice dimensions worth adding to the [trade-journal](../../skills/trade-journal/SKILL.md) review: direction, share-size bucket, share-price bucket, and holding-time bucket. We currently slice by setup tier and rule broken.

**Market risk sizes, it does not veto (p. 150):** *"Common times of heightened risk include ... earnings season each quarter, economic report releases, Federal Reserve meetings... During these times participants can still find good, profitable setups in the market, but they should be traded LESS AGGRESSIVELY (in share size) than during more 'normal' conditions. VARYING YOUR POSITION SIZE IS THE EASIEST WAY TO DEAL WITH CHANGING RISK LEVELS."* Same conclusion `ta_regime` reaches.

**On volume for the fourth time (p. 155):** *"A common mistake is to wait for volume to show up before exiting a loser. If you fall into this common trap, you often will be too late because the volume is usually greatest AFTER price has moved."*

---

### ch 18 â€” the screening funnel, which is directly comparable to our morning screen

| Stage | Size | Cadence | Criteria |
|---|---|---|---|
| **Master list** | 300â€“400 | Friday PM / Saturday AM | *"solid trends, unusual volume, market-leading stocks and ETFs"* |
| **Week scan** | 100â€“150 | weekly | *"those that have entered a NEW TRENDING CAMPAIGN on a daily timeframe"* + *"trending stocks that appear to be experiencing a PULLBACK that could refresh back into alignment with the primary trend over the course of the next week"* |
| **Day scan** | 20â€“40 | daily, **15â€“30 min after the close** | *"near a low-risk, high-potential trade entry level"* |
| **Focus** | 2â€“3 | 5â€“10 min before the bell | highest-probability, aligned with the market's direction |

Universe preferences, stated as his own and not as rules: **$5â€“$40/share**, **ADV 400,000 to 5 million** (*"liquid enough to get into and out of without too much difficulty"*), mostly NASDAQ, and he avoids commodity-linked names because he trades them badly â€” *"Note, however, that the above is what works best FOR ME."* Daily additions come from *"all of the unusual moves with at least ONE MILLION SHARES occurring on that day once the market has closed"* plus the percentage gainer/loser lists.

Two structural comparisons to `scripts/morning-screen.js`:
- His funnel has **four** stages with different cadences â€” a weekly-rebuilt candidate pool feeding a daily-rebuilt shortlist. Ours routes to Weeks/Months buckets, which is the same idea applied to holding period rather than to scan frequency. The *pullback-refreshing-into-alignment* criterion for the week scan is the one clause we do not have: it is a **continuation-after-a-dip** filter, not a breakout filter.
- He runs the screen **after the close**, which sidesteps the partial-bar problem entirely. Our 05:30 PT run is before the open on complete prior-day bars, which is equivalent. Good.

**FINDING â€” the alert offset, confirmed with a second worked number (p. 173):**
> *"If, for instance, the uptrending stock has found support over the last day or two and has formed short-term resistance at 24.50, I will then write 24.48 next to the symbol. This level will then be entered into my trading platform's alerts section... It is important to set the alert A COUPLE OF PENNIES BELOW the actual level at which more important buying will be triggered; it gives me the chance to pull the stock up on a live chart... before tripping the trigger on a trade."*

Two pennies on $24.50 (~8bps), against ~4 pennies on $25.30 (~16bps) in ch 12. So the convention is *a couple of pennies*, absolute, not a percentage. And the purpose is stated: *"Being a predatory anticipator allows me to minimize the likelihood of allowing emotion to cloud my short-term thinking."* Concretely for `alert_create`: an alert placed exactly **at** a drawn level is the wrong place; it should sit a hair inside.

**FINDING â€” Figure 18.1, a relative-strength lookup table, with his own honesty note attached:**

| Market | Strong stock | Weak stock |
|---|---|---|
| Unchanged | even to up 2% | even to down 2% |
| Up 2% | up 2 to 5% | even to +2% |
| Down 2% | even to down 2% | down 2 to 5% |

> *"Though NOT THE RESULT OF ANY FORMAL STUDY, this table is a rough approximation of the concept of relative strength."*

He labels his own table as unmeasured. Useful as a sanity band for `relative_strength` output â€” a "strong" stock down 3% on an unchanged tape is outside his band â€” but it carries no evidential weight and should be quoted with his caveat if quoted at all.

**Pre-market rules (pp. 174â€“175)** â€” three numeric gates, all ~2%:
- Held overnight, moving **against** you by more than **2â€“3%** â†’ monitor closely; *"If the weakness persists, I typically exit the trade quickly, particularly if there is heavy volume."*
- Long candidate **gapping down by more than ~2%** â†’ *"I eliminate it from consideration."* Short candidate gapping up ~2% â†’ same.
- Overnight position gapping **in** your favour â†’ *"exit at least a portion in the pre-market to lock in a small gain."*
- The pre-market trail: a **tick chart** (50 ticks for illiquid names up to 500 for very active ones) with a **VWAP** moving average â€” *"remain in the position as long as the VWAP is moving in the direction of my trade. Once the stock moves below (assuming a long position) the VWAP in the pre-market, I exit the majority."*
- *"Pre-market trading activity is often very thin and choppy and is generally better used to LIQUIDATE OVERNIGHT HOLDS than to initiate new positions."* â€” a fourth independent statement that extended-hours data is for exits, not entries. Supports `session.js` treating the partial bar's `high`/`low`/`volume` as unusable while `close` remains meaningful.
- *"the most likely scenario for the market each day is that it will CONSOLIDATE WITHIN A RANGE... Because directional moves typically occur in short bursts of activity, most of the time they are consolidating those moves."* A stated prior that the default daily outcome is range, not trend.

**ch 17/18 checklists â€” the edge definition (p. 179â€“180), condensed.** Nothing new but it is the book's own summary, and every clause has appeared above: trade in the direction of the primary trend *(identified by the direction of the 50 DMA)*; longs only with positive MA slope, shorts only with negative; be aware of the market but *"not ignoring a strong stock setup because of an unfavorable market backdrop (you may want to adjust your trade SIZE)"*; time entries on shorter timeframes as trends align; **define risk from support/resistance levels, "rather than on percentages or other random methods"**; identify levels to set price objectives; *"large short positions represent future demand but short sellers are often right; their timing may just be off"*; enter at the onset of a new short-term momentum campaign; cut losses when stops are violated; *"trade management should occur on the shorter-term timeframe and should be based on the definition of trend."*

Closing caveats worth keeping, because they bound the whole book: *"there are no riskless directional trades, which is why no trade plan is complete without a backup plan"*; *"no strategy will always work"*; and on measurement, *"At the end of each trading day you shouldn't focus solely on your P/L. Instead, focus on your thought process during the day and how well you executed your plan. If you consistently execute your trades according to plan and still lose money, then you need to reevaluate your approach."*

**Author credentials (p. 183):** Brian Shannon â€” full time in markets since 1991; broker, owned a day-trading firm, managed a hedge fund, ran a proprietary desk while being its most profitable trader; Head of Research and Training for MarketWise. Practitioner, not researcher â€” which is consistent with the book's shape: many precise, self-consistent operational rules and almost no measurement. He flags this himself twice (the bear-market statistics, and Figure 18.1).

