# Smitten, *Trade Like Jesse Livermore* (2005) — reading notes

238 pages, extracted as text with `pdftotext -layout` to `scratchpad/livermore.txt` (7408 lines).
Read sequentially. Structure: Timing / Money Management / Emotional Control.

## Read log
- [x] Preface + ch 1–2 (lines 1–1157) — biography, "timing is everything"
- [x] ch 3 Trading Discoveries (1158–1641)
- [x] ch 4 Pattern Recognition / Pivotal Points (1642–2248+)
- [ ] ch 5 Money Management
- [ ] ch 6–9 Emotional control, daily prep, quotes
- [ ] ch 10 Summary of rules
- [ ] ch 11 Secret Market Key

---

## GAP 1 — Industry group / sector, and "Tandem Trading". THE BIG ONE.

This is Livermore's Discovery 2 and 3, and it is the spine of his system. We have
**nothing** equivalent.

> "Livermore found that industry group movement was the key to individual stock movement...
> Stocks did not move alone. When they moved, they moved in sectors and industry groups."
> "**Livermore never tracked a single stock.** He first tracked the industry group movements."
> "Livermore decided that a legitimate group movement had to include **at least the two leaders
> of the group**, and eventually all the stocks in the group would follow."

**Top Down Trading — four ordered steps:**
1. Line of least resistance on the **market the stock trades on** (Dow / Nasdaq / Amex — explicitly says check the right one)
2. The **industry group** direction
3. **Tandem Trading** — the stock AND its sister stock, the two leaders of the group. "Never look at only one stock — look at two — track two."
4. All three in one glance; **both stocks must have the same pattern** to initiate a trade in that group

Two more clauses worth having:
- If a stock in a favoured group does **not** move up with the others, that is a red flag it is
  weak or sick — a short candidate, or at least do not buy it.
- Exception: when one stock is >50% of the group's sales (his examples: Intel, Microsoft), one
  stock will do, because the group must follow the dominant leader.
- **Sector ≠ Group** and he is explicit that people conflate them. Sector = all groups in an area
  (Financial); Group = the specific one (regional banks).

**What we have:** `relative_strength` (vs an index only), `position_correlation` (between held
positions). Neither answers "is this stock's GROUP moving" or "does the sister stock confirm".

**Also his top-calling method:** groups turn BEFORE the market. "As the favored groups of the
moment became weaker and collapsed, a correction in the overall market was usually on the way."
He notes his own failure here too — in 1929 copper and motors topped, he shorted the whole market
too early and "lost his shirt", and had to wait ~6 months for utilities to confirm. So the rule he
derived is: act on the group you can see, do NOT generalise to the market until a second group
confirms.

---

## GAP 2 — One-Day Reversal. Fully specified, three clauses, computable.

> "A One-Day Reversal occurs when the high of the day is higher than the high of the previous day,
> but the close of the day is below the close of the previous day, and the volume of the current
> day is higher than the volume of the previous day."

That is exact and testable. Read as a danger signal / exit, not an entry. Needs a noise floor —
this looks like it will fire often, so measure before shipping.

Related: **spikes** = any strong deviation from normal, price or volume, "at least a 50 percent
increase over the average daily volume". He treats high volume AND low volume both as aberrations.

---

## GAP 3 — The entry-quality gate. Concrete number.

> "if you buy more than **5 percent to 10 percent above the initial Reversal Pivotal Point**, you
> may be too late. You may have lost your trading edge because the move is already well underway."

We have no "have I chased this" check. `draw_trade_plan` computes R:R but nothing says the entry is
too far from the trigger. Pairs with Shannon's "the further the stock has traveled from that level,
the greater risk exposure".

---

## GAP 4 — The probe / pyramid sequence.

Money-management rule 1, and it is a SEQUENCING rule, not a sizing rule:
> "First, he would send out a probe. He would buy a small percentage of the overall stock position
> that he wanted to eventually establish; if he was correct on the first trade, he made a second
> trade."

We have `position_size_constrained` (how many shares) but nothing for **how to stage entry across
confirmations**. Note this is the opposite of averaging down — he is emphatic: "as an ironclad
Livermore rule, **never average losses**."

---

## Mostly COVERED, with the caveats already in the repo

| Livermore | Ours |
|---|---|
| Reversal Pivotal Point = change in basic trend, volume climax 50–500% over average | `structure_analyze` CHoCH + `effort_vs_result`. His volume clause is more specific |
| Continuation Pivotal Point = consolidation inside a trend, then breakout the same way | `volatility_state`, `breakout_check`, `legs_classify` time corrections |
| Consolidating base / saucer | `vcp_check`, `volatility_state` |
| Break-out to new high | `breakout_check`, `momentum_read` 52-week high. **His mechanism is exactly George & Hwang's**: overhead supply from people who bought the old high and want out at breakeven |
| Trend lines / channels | `pivots_kernel`, channel detection |
| Never lose more than 10% on a trade | `position_size_constrained` risk budget — but the 10% CAP itself is not encoded |
| Trade with the trend / line of least resistance | `market_regime`, `mtf_analyze`, `stage_plan` |
| Max 5–10 positions | `portfolio_heat`, `position_concentration` |
| No stock is too high to buy or too low to short | already the repo's stance |

## Claims worth flagging as UNMEASURED

1. **"Positions entered correctly move quickly in your favor."** He states it as a rule — "the
   stock should move in the direction of your trade almost simultaneously with entering the trade"
   — and says a position that "just lies there, languishing" should be closed immediately. That is
   a testable claim with triple-barrier labelling and it is **already on this repo's todo list**
   from the Bellafiore pass. Livermore is a second independent source for it.
2. **Final Mark-up Phase** — "the largest part of a stock movement occurred in the last two weeks
   or so of the trade." Directly testable: is the last ~10 bars of a trend leg disproportionately
   large? Needs a random-walk floor (a trend's last leg is selected for being before the end).
3. **Market direction thirds** — "the stock market goes up approximately a third of the time,
   sideways a third, down a third." Checkable, and it is his stated reason for trading short.
4. **Groups lead the market by 3–6 months** — he claims the 1999 leaders (Amazon, Yahoo, AOL,
   Lucent, Cisco, Sun, Microsoft) topped "three to six months before the entire market followed".
   That is a lead-lag claim with a number on it.

## Honesty notes on the source itself

- Smitten is a **biographer**, not the trader. The book is a reconstruction from interviews with
  Livermore's son and daughter-in-law plus the earlier biography — not Livermore's own writing.
- Livermore **did not use charts**. "He used his complex mathematical formulas... Charts now are
  used to illustrate the Livermore Trading System details." So every chart in the book is the
  author's later rendering, not Livermore's method.
- The author was building and selling **software** based on this (SMKT, Nasdaq bulletin board,
  April 2003) and says so in the preface. That is a commercial interest in the system appearing
  systematic.
- Livermore went **bankrupt four times** and shot himself in 1940. The book says so plainly. Any
  "greatest trader who ever lived" framing has to sit next to that.
- Survivorship: one trader, 1890s–1930s, no control group, no out-of-sample anything.

---
## Read log update — COMPLETE
ch 5 Money Management (2375–2704), ch 10 Summary of Rules (5847–6146),
ch 11 Secret Market Key (6374–6613) all read. ch 6–9 are emotional control,
daily routine and a quote index — no new mechanics.

## GAP 1 confirmed and SHARPENED — the "Key Price" is the mechanic

Chapter 11 is Livermore's own 1940 text, and it gives the group-confirmation rule a
precise form he calls the **Key Price**:

> "I do not take the action of a single stock as an indication that the trend has been
> positively changed for that group. Instead **I take the combined action of two stocks
> in any group** before I recognize the trend has definitely changed, hence the Key Price...
> There is **danger of being caught in a false movement by depending upon only one stock.**
> The movement of the two stocks combined gives reasonable assurance."

Mechanic: a Natural Reaction/Rally needs ~6 points from the extreme on a stock above $30.
The **Key Price requires the two leaders COMBINED to move ~12 points** — so U.S. Steel moving
5⅛ counts if Bethlehem moved 7.

**A 1940 artefact that must not be copied literally:** six POINTS on a $30 stock is 20%. The
threshold has to be re-expressed as a percentage or in ATR, and he says so himself —
"certain adjustments in the formula must be made in considering the very low-priced issues."

He also gives a real worked example of the "sick stock in a healthy group" rule: after war was
declared in Europe, every prominent group recovered to new highs **except Steel**. Four months
later it emerged the English government had sold 100,000 shares of U.S. Steel and Canada 20,000.
U.S. Steel ended 26 points below its September high while the other three groups were off only
2–12¼. His conclusion is the repo's own stance: "there is always a reason... the chances are you
will not become acquainted with that reason until some time in the future, when it is too late."

**The six-column state machine** (ch 11): Secondary Rally / Natural Rally / Upward Trend /
Downward Trend / Natural Reaction / Secondary Reaction. A finer-grained trend-state classifier
than Shannon's four stages, driven by the same reaction threshold. Note he is explicit it is for
MAJOR moves only: "the formula does not provide points whereby you can make additional trades
with assurance on intermediate fluctuations."

## GAP 4 confirmed — the probe ratio is specific

> "Start with a 200-share purchase on the Pivotal Point — if the price goes up, buy an additional
> 200 shares, still within the Pivotal Point range. If it keeps rising, buy another 200 shares...
> you can go ahead and purchase the final 400 shares."

So 20/20/20/40 of the intended final size, and **"each additional purchase must be made at a
higher price"** (lower for shorts). His three sub-rules: don't take the whole position at once;
pay MORE for each lot (dollar-average UPWARD); and fix the total intended size in advance.

The logic is a self-test, not a sizing trick: "Each trade... must always show the speculator a
profit on his prior trades. The fact that each trade showed a profit is living proof, hard
evidence, that your basic judgement is correct."

## The 10% rule, and his own loss table

Money Management rule 2 is a hard cap: **never lose more than 10% of the invested capital on a
trade**, and it doubles as a time rule — "when you have lost 10 percent or more, you must exit."
Plus: never meet a margin call, never average losses. His Table 5.1 is the recovery arithmetic
we already carry in `recoveryTable` (50% loss needs 100% gain).

## DATA CHECK — the group gap is BUILDABLE

- TV scanner exposes a **`sector`** field (`src/core/scanner.js` line 63).
- TA exposes **`/api/sectors`** (`ta_api.js` line 212, `sectors()`).
- `relative_strength` already compares a symbol to a benchmark; pointing it at a group proxy
  rather than an index is a small change.

So nothing blocks building group + tandem confirmation. What is missing is the group MEMBERSHIP
map (which sector each name is in, and who the two leaders are), and the scanner's `sector` field
plus TA's endpoint between them look sufficient.

---

# VERDICT — one genuinely new strategy, three new mechanics

## NOT covered (worth building)
1. **Industry-group + tandem (Key Price) confirmation.** Livermore's actual core. We have
   `relative_strength` (vs an index) and `position_correlation` (between holdings) — neither
   answers "is the GROUP moving" or "does the sister stock confirm". This is a new strategy
   entry, not just a tool: *trade the leading stock in a leading group, only when the second
   leader shows the same pattern.* Buildable from the scanner's `sector` field + TA `/api/sectors`.
2. **One-Day Reversal** — three exact clauses (higher high, lower close, higher volume). Needs a
   noise floor before it ships; it looks like it will fire often.
3. **Probe / pyramid entry sequencing** — 20/20/20/40, each add at a better-for-you price, total
   fixed in advance. Complements `position_size_constrained`, which answers size but not staging.
4. **Chase gate** — "if you buy more than 5–10% above the initial Reversal Pivotal Point you may
   be too late." Nothing in the repo checks entry distance from the trigger.

## Already covered
Pivotal points (≈ CHoCH/BOS + `effort_vs_result`), continuation pivotal points (≈ flags,
`volatility_state`, `legs_classify` time corrections), consolidating base/saucer (`vcp_check`),
breakout to new high — and note **his supply mechanism IS George & Hwang's 52-week-high
explanation**, arrived at independently in the 1920s. Trend lines/channels, never average down,
cut losses, let winners run, max 5–10 positions, the recovery table: all present.

## Do NOT build
The six-point Natural Reaction threshold as stated (a 1940 point-based rule = 20% on a $30 stock),
and the six-column ledger as a literal artefact. The *idea* — a reaction threshold that separates
minor oscillation from a real move — is already `legs_classify` plus `scaling_exponent`.

## Source quality — record this beside anything taken from it
- Smitten is a **biographer**, not the trader; this is a reconstruction from interviews.
- **Livermore did not use charts.** Every chart in the book is the author's later rendering.
- The author disclosed a **commercial interest**: he was building and floating software on this
  system (SMKT, Nasdaq bulletin board, April 2003).
- Livermore went **bankrupt four times** and died by suicide in 1940. Both are in the book.
- n = 1 trader, 1890s–1930s, no control, no out-of-sample. Everything here is **Tier C** by this
  repo's own scale unless separately measured.
