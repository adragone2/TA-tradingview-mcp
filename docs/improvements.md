# Improvement tracker — 2026-07-30 deep audit

The prioritised backlog from the full-repo audit (90 core modules, 42 tools, 27
scripts, 77 test files, docs, skills, scheduled prompts) plus an **18-shape live
probe of TradingView's drawing API over CDP**. Every item here was verified —
probed live, read from source, or cited — before it was listed.

**Status legend:** `todo` → `in-progress` → `done` (code merged, tests green) →
`verified` (checked against the live chart / live run, per the repo rule that a
green unit test is not enough here).

Update the Status column in the same commit as the work. An item is not `done`
while its tests are red, and not `verified` until someone has looked at the
chart or the run output.

---

## P0 — broken or misleading today

| ID | Item | Status | Evidence / acceptance |
|---|---|---|---|
| P0.1 | **Sunday scheduled prompt reads schema-1.0 paths.** `skills/sunday-review/scheduled-task-prompt.md` (and the live copy in `~/.claude/scheduled-tasks/sunday-review/SKILL.md`) tell the 08:00 agent to read `assessment.market_regime`, `assessment.trade_plans`, `assessment.channels` — all moved under `analysis.` in schema 2.0, so the agent extracts `undefined` and the Sunday summary silently loses those sections. Same failure class as the morning prompt bug. Fix both copies; also refresh `skills/sunday-review/SKILL.md` (still documents `our_view` at top level, `--holdings` as opt-in) and the Sunday section of `docs/routines.md` (still "7–12 min, ~60 tickers, actionable only"). Add a source-contract test that the prompt contains no bare 1.0 paths. | verified | 18 guard tests incl. a two-copy drift check; negative control fails on the old prompt (3 bare paths); 13 `analysis.*` paths resolved on 59/59 rows of the real report; 1.0 paths resolve on 0/59 |
| P0.2 | **Class-share tickers are a live spread trap.** `resolveTaSymbol('BRK-B')` passed through `chartable: true`, and TradingView reads the hyphen as a SPREAD. Live-probed: `BRK-B` → `LSE_DLY:BRK-BATS:B` at 1382.30 — a London-listing-minus-B-shares spread, filed as Berkshire — while `BRK.B` → `BATS:BRK.B` at 509.68. Mapped `XXX-Y` → `XXX.Y` (single trailing letter only; two-letter suffixes are deliberately NOT mapped — preferred/unit forms have their own spellings and guessing is the same error class, with `expect` as the loud backstop). Crypto branch untouched and ordered first. | verified | Live probe of both forms; identity chain `expect BRK.B` ↔ loaded `BATS:BRK.B` matches; 14 tests in `tests/ta_symbols.test.js` |
| P0.3 | **Always-loaded docs had drifted counts.** 184→187 tools, 18→20 strategies, **Six→Seven REJECTED** (two-leader confirmation had never been added to the prose), 8+1→8+2 screens, 07:00 ET→05:30 PT — across CLAUDE.md, START-HERE.md, screening.md, analysis-workflow.md, ticker-playbook, the `src/server.js` MCP instructions block and `src/tools/playbook.js` descriptions. `tests/doc_counts.test.js` derives every count from the same source the code reads; a reworded sentence is itself a failure ("a guard that matches nothing passes forever"). | verified | Mutation-tested during review: 187→186 fails by name, revert passes 10/10; imports confirmed pure |
| P0.4 | *(folded into P0.1)* `routines.md` Sunday section + `skills/sunday-review/SKILL.md` refresh for 2.0 / holdings-default / crypto-exclusion. | verified | — |
| P0.6 | **`market_condition` in `scripts/sunday-review.js` reads 1.0 paths** (`t.assessment?.market_regime` at ~531/534/539), so the report header block is vacuous on every 2.0 report: `regime_counts: {}`, `broad_chop: false` as a side effect of reading nothing. True split on 2026-07-30 is 50 choppy / 6 mixed / 3 trending (84.7% choppy). Same defect class as P0.1, in the script instead of the prompt; found by P0.1's agent, confirmed independently. Fix the paths, add a guard, remove the KNOWN GAP paragraphs from both prompt copies. | verified | Guard fires on mutation (3 named lines incl. the ok[0] variant); fixed block re-evaluated verbatim over the real report: {} -> {choppy:50,mixed:6,trending:3}, broad_chop false -> TRUE; KNOWN GAP gone from both copies; 22 prompt tests |
| P0.5 | **`ta_walls.js` has the same spread trap** — `applyWallsForSymbols` (~line 405) calls `chart.setSymbol` on a bare ticker with no `resolveTaSymbol` and no post-load identity check. Latent because the walls list is ETFs in practice. Route it through the resolver + verify the loaded series. (Found during P0.2's review.) | done | Merged from the owner's session (worktree branch): resolver-first, SKIPPED distinct from FAILED, lazy chart capture, loaded-symbol identity check ('no answer is a refusal'). Merge surfaced a P0.2 collision — BRK-B was the backstop test's example and the resolver now owns it; example moved to the deliberately-unmapped two-letter form, promotion asserted explicitly. 27 tests. Live walls apply not yet exercised (needs the TA-Trading layout) — verify on the next walls-overlay run |

## P1 — drawing upgrades (all live-probed 2026-07-30; see probe table below)

| ID | Item | Status | Evidence / acceptance |
|---|---|---|---|
| P1.1 | **Wire `drawPosition` into `drawFindings`** for the verdict-side trade plan: one shaded, draggable R:R box (`long_position`/`short_position`) replaces 3 hlines + 3 labels. `position_tool.js` exists, works, is registered — and the unified drawer never calls it. Keep hlines as fallback when account/risk unknown. | in-progress | The verdict-side plan on a live analysis renders as a position tool; clear/signature rules still hold |
| P1.2 | **`parallel_channel` for channels** (probed 3/3 points) — replaces the two separate trend lines in `assessment_draw.js`; one entity, moves together. | in-progress | Channel on a live analysis is a single parallel_channel entity |
| P1.3 | **Re-adopt native `head_and_shoulders`** (probed **7/7 points landed** — the old "native tools broken" conclusion was `triangle_pattern`-specific). One entity instead of 7 trend lines. Keep the Escape disarm. | in-progress | H&S on a live analysis is one native entity, all 7 points on real pivots |
| P1.4 | **`triangle_pattern` is confirmed broken** (probed 2/5, reproducibly) — keep the trend-line reconstruction and record the probe result in `drawing.js` so nobody re-tries it. | in-progress | Comment/documentation only |
| P1.5 | **Draw fibonacci** — `assess()` computes it and nothing draws it. Native `fib_retracement` probed 2/2. | todo | Fib levels appear as one native tool when fibonacci block is drawn-worthy |
| P1.6 | **Label collision fix** with `callout`/`signpost`/`note` (all probed working): the ALM/MTSI overprinting is text-on-hline collision that `hline` merging cannot fix. | todo | A dense chart renders with readable, offset labels |
| P1.7 | **Earnings date `vertical_line`** on-chart (`days_to_earnings` already known per ticker) — catalyst risk visible where the stop is. | todo | Line at the earnings date with days-until label |
| P1.8 | **`fixed_range_volume_profile`** (probed 2/2) to draw the value area instead of reporting VAH/VAL numbers only. | todo | Value area rendered natively on request |
| P1.9 | **`elliott_impulse_wave`** (probed 6/6) — draw the agreeing count when `elliott_survey` converges across sensitivities. | todo | Only drawn on agreement; never a lone count |
| P1.10 | **Do-not-use list**: `price_label` creates nothing; `curve` landed 2/3 (encoding unclear). Record beside the flag-mark trap in `drawing.js`. | in-progress | Documented with probe date |
| P1.11 | **Multipoint settle**: the fixed 500ms wait is empirically tight — capture created ids after settle-verify rather than fixed sleep. | in-progress | No late-resolving create ever escapes id capture |

## P2 — pattern recognition

| ID | Item | Status | Evidence / acceptance |
|---|---|---|---|
| P2.1 | **Cup-with-handle detector** — absent, and Bulkowski rank **3 of 39**: 5% break-even failure, 54% avg rise, 61% meet target, 62% throwback (thepatternsite.com/cup.html). Measurable clauses (U-shape, handle in upper half, rim tolerance, 7–65wk) + the standard random-walk noise floor before it ships. | todo | Detector + noise floor measured + strategies.json entry with evidence tier |
| P2.2 | **Throwback modelling in `breakout_check`** — Bulkowski over 10,348 patterns: throwbacks 74% after high-volume upward breakouts; patterns perform better WITHOUT one 97% of the time. Add descriptive throwback-likelihood + "did the throwback hold" clause, citation attached. | todo | breakout_check reports it; docs cite the numbers |
| P2.3 | **One pivot backbone** — `structure.findSwings`, `assessment_draw.windowPivots` and kernel extrema are three implementations of "what is a swing". Consolidate on the kernel-validated one. | todo | windowPivots deleted; all detectors share one module |
| P2.4 | **Max-age cutoff for drawn geometry** — a confirmed pattern 45+ bars old still draws at full weight; `patternRank` only penalises within selection. | todo | Stale-by-N-bars patterns reported, not drawn |
| P2.5 | **H&S neckline slope** in detector output — Bulkowski's stats differ by slope direction; both armpits already computed. | todo | `neckline_slope` field + doc note |
| P2.6 | Gap classification (breakaway/runaway/exhaustion) as a descriptive detector; PIP/template matching (Leigh et al. bull flag) as an LMW-style second opinion. Only with noise floors. | todo | Research-grade; optional |

## P3 — process & code quality

| ID | Item | Status | Evidence / acceptance |
|---|---|---|---|
| P3.1 | `finviz.js` spawns bare `python` — env-configurable (`FINVIZ_PYTHON`), and run the three scrapes concurrently with the scanner/SPY fetches (they never touch the chart) to hide ~90s. | todo | Configurable + overlapped; unattended run verified |
| P3.2 | `hline` dedupe tolerance is a fixed 0.4% — ATR-scaled would stop over-merging quiet large-caps and under-merging volatile small-caps. | todo | Tolerance derived from ATR; merged_levels still reported |
| P3.3 | `scripts/draw-smoke.js` — draw each ADOPTED shape, assert point counts (this audit's probe, kept runnable) so the next triangle_pattern-style regression is caught. | todo | Runnable smoke script + doc pointer |
| P3.4 | Auto-`alert_create` at confirmed completion levels — **opt-in only** (alerts fire on the live account). | todo | Off by default; explicit flag |
| P3.5 | Annotate entry hypotheses generated outside the intraday execution window (10:15–14:30 ET, already data in `timeframe_policy`). | todo | Annotation present on out-of-window INTRADAY plans |
| P3.6 | SPY carries 2 untracked `horizontal_line`s (found during the probe) — `clear-orphans` dry run to identify; owner decides. | todo | Identified and dispositioned |

---

## Appendix — live shape probe, 2026-07-30 (AMEX:SPY, CDP, all cleaned up)

| Shape | Points asked | Landed | Verdict |
|---|---|---|---|
| parallel_channel | 3 | 3 | adopt (channels) |
| fib_retracement | 2 | 2 | adopt (fibonacci) |
| regression_trend | 2 | 2 | available |
| callout | 2 | 2 | adopt (labels) |
| price_label | 1 | **nothing created** | do not use |
| signpost | 1 | 1 | available (event marks) |
| note | 1 | 1 | available |
| vertical_line | 1 | 1 | adopt (earnings date) |
| curve | 3 | 2 | do not use (encoding unclear) |
| path | 4 | 4 | available |
| polyline | 4 | 4 | available |
| arrow_marker | 2 | 2 | available |
| pitchfork | 3 | 3 | available |
| ellipse | 2 | 2 | available |
| fixed_range_volume_profile | 2 | 2 | adopt (value area) |
| head_and_shoulders | 7 | **7** | adopt — the old failure was NOT general |
| triangle_pattern | 5 | **2** | broken, reproducibly — keep trend lines |
| elliott_impulse_wave | 6 | 6 | adopt (agreeing counts only) |

Sources: [Bulkowski — cup with handle](https://thepatternsite.com/cup.html) ·
[Bulkowski — throwbacks](https://thepatternsite.com/throwbacks.html) ·
[Bulkowski — pullbacks](https://www.thepatternsite.com/pullbacks.html)
