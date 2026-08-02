import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * ONE analysis workflow, and it must keep every fix that went into it.
 *
 * This exists because unifying the workflow silently DROPPED one. `ticker_analyze`
 * was rebuilt on top of `drawFindings` — correct, since drawFindings owns the
 * geometry — but drawFindings clears with `scope: 'mcp'` scoped to a group, so the
 * owner's clear-everything-first rule vanished in the merge. Nothing failed; the
 * chart just quietly had stale drawings under the new ones again.
 *
 * A union that loses a term is not a union. These are source contracts because the
 * behaviours span a live chart, a scanner and a second server, and the thing worth
 * guarding is that the wiring stays wired.
 */
const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');
const DRAW = 'src/core/assessment_draw.js';
const ORCH = 'src/core/ticker_analyze.js';

describe('the workflow is unified, not duplicated', () => {
  test('the orchestrator calls assess() and re-implements nothing', () => {
    const t = src(ORCH);
    assert.match(t, /assess\(bars, benchmark\?\.bars \|\| null\)/,
      'must use the shared assessment, and must PASS IT A BENCHMARK — the second argument was `null` '
      + 'here, so relative_strength.leadership came back null on every unified analysis while the '
      + 'completeness score still marked the section OK');
    for (const forbidden of ['detectPatterns(', 'momentumProfile', 'surveyDivergences', 'detectVCP(', 'findKeyLevels(']) {
      assert.ok(!t.includes(forbidden),
        `ticker_analyze re-implements ${forbidden} — assess() already returns it, and assessment.js `
        + 'opens by forbidding a second copy: "two copies drift, and the drift is silent".');
    }
  });

  test('the orchestrator draws only through drawFindings', () => {
    const t = src(ORCH);
    assert.match(t, /drawFindings\(/);
    assert.ok(!t.includes('drawPatternGeometry'),
      'drawing belongs to drawFindings; calling the geometry drawer directly forks the drawer');
    assert.ok(!t.includes('drawShape('),
      'a hand-rolled draw call beside drawFindings is how the geometry got lost the first time');
  });
});

describe('every fix survives the union', () => {
  test('an ANALYSIS clears the whole chart first', () => {
    /**
     * The one that was lost. `scope: 'mcp'` leaves drawings from older code, from a
     * scan, or from TradingView's own pattern tools sitting under the new ones — on
     * a live DLO chart it left a Head/Shoulders annotation that was then nearly
     * reported as the owner's own analysis.
     */
    assert.match(src(DRAW), /clear_scope === 'all'/, 'drawFindings must support a full clear');
    assert.match(src(ORCH), /clear_scope = 'all'/,
      "the analysis path must DEFAULT to the full clear — a caller that wants less must say so, "
      + 'because the failure mode of getting this wrong is silent and looks like a finding');
  });

  test('only the unattended batch narrows the clear, and it says why', () => {
    /**
     * `scope: 'all'` on twenty machine-selected charts at 05:30 would delete a walls
     * overlay or anything hand-drawn with nobody present to be asked. The batch
     * passes 'mcp', which still clears its own work by TEXT signature — signatures
     * survive the session restart that kills every entity id.
     */
    const m = src('scripts/morning-screen.js');
    assert.match(m, /clear_scope: 'mcp'/, 'the unattended batch must narrow the clear explicitly');
    assert.match(m, /KEEP/, 'and KEEP sections must be excluded from the analysis set entirely');
  });

  test('the batch scripts still clear narrowly', () => {
    assert.match(src(DRAW), /clear_scope = 'mcp',/,
      'morning-screen and sunday-review walk many symbols and must not wipe a walls overlay');
  });

  test('levels are the swing-anchored primaries, in the shared drawer', () => {
    const d = src(DRAW);
    assert.match(d, /selectPrimary\(allLevels/);
    assert.match(d, /last_high/, 'anchored to the swing extreme, not to spot');
    assert.ok(!/all_supports \|\| \[\]\)\.slice\(0, 3\)/.test(d),
      'the top-3-by-score selection is back — score is test count, which carries no measured '
      + 'information about whether a level holds');
  });

  test('patterns are drawn as geometry, and only once each', () => {
    const d = src(DRAW);
    // UPDATED by P2.4 (2026-07-30): the selector's input is `agePlan.fresh`, the
    // stale-filtered form of `stable`. It is still the selector that collapses
    // duplicate shapes — only what reaches it changed.
    assert.match(d, /planPatternDrawings\(agePlan\.fresh/, 'duplicate shapes must be collapsed');
    // `hline` is passed too, so the pattern's own levels dedupe against every other
    // block's — the wedge break level and the trade plan's ENTRY landed on the same
    // price and overprinted before this.
    assert.match(d, /drawPatternGeometry\(p, bars, group, put, hline\)/);
    const p = src('src/tools/patterns.js');
    assert.match(p, /drawPatternGeometry/,
      'patterns_draw must delegate; it once drew a lone horizontal line per pattern and erased '
      + 'the channel boundaries, wedge edges and flag poles');
  });

  test('only the VERDICT SIDE is drawn, and the rest is reported', () => {
    /**
     * ALM drew a bullish falling wedge targeting 22.3 and a bearish head-and-shoulders
     * targeting 8.19 at once — 22 shapes, a stop at 22.99 and a target at 8.19 on a
     * stock at 11.67. GRMN, verdict BULLISH, still drew seven shapes for a bearish
     * head-and-shoulders that had stopped forming 45 bars earlier.
     *
     * `bias` is passed SEPARATELY from `side`. `side` is 'long'/'short' and describes
     * the position being reviewed; the caller that derived it collapses NEUTRAL to
     * 'long', so filtering on `side` would delete every bearish finding on an
     * undecided chart and call it a clean-up.
     */
    assert.match(src(ORCH), /bias: verdict\?\.bias/, 'the analysis path must pass its own verdict');
    const d = src(DRAW);
    /**
     * UPDATED by P2.4 (2026-07-30): the selector is now fed `agePlan.fresh` rather
     * than `stable`, because the max-age cutoff has to run BEFORE the selection —
     * see 'stale geometry is excluded before anything selects or draws' below. The
     * `{ max_patterns: 6, bias }` half is unchanged and still asserted.
     */
    assert.match(d, /planPatternDrawings\(agePlan\.fresh, \{ max_patterns: 6, bias \}\)/);
    assert.match(d, /const stable = \(rawPatterns \|\| \[\]\)\.filter/,
      'and the stability filter must still be the input to the age filter');
    assert.match(d, /const wantLeg = \{ BULLISH: 'long', BEARISH: 'short' \}/,
      'trade-plan legs must be filtered too — geometry alone leaves the contradicting stop and target');
    assert.match(d, /plans_suppressed/, 'what was withheld must be reported, never silently dropped');
    /**
     * P2.4 review (2026-07-30): the two plan-level rules moved into `planGate`,
     * a PURE function, after a neutered-condition mutation (`if (false && ...)`)
     * passed the old source-text regexes while killing the behaviour. The
     * behavioural contract now lives in tests/drawing_natives.test.js
     * ('planGate — the plan-level gate, behaviourally'); what this file pins is
     * the WIRING and the ORDERING.
     */
    assert.match(d, /drawnPatterns\?\.size && tp\?\.pattern && !drawnPatterns\.has\(tp\.pattern\)/,
      'the not-drawn rule must live in planGate');

    /**
     * ADAPTED for the native position tool.
     *
     * The intent is unchanged — a plan whose pattern was not drawn must not put a
     * stop and a target on the chart — but the plan is now drawn as ONE
     * `long_position` / `short_position` box rather than three horizontal lines,
     * and a box placed above both guards would reintroduce exactly the ALM
     * failure in a shape the line-based assertions cannot see.
     *
     * So the ordering is asserted directly: the planGate call must precede the
     * position-tool decision inside the same loop, and the verdict filter too.
     */
    const gateCall = d.indexOf('const gate = planGate(tp, stalePatterns, drawnPatterns)');
    const verdictGuard = d.indexOf('leg contradicts the ${bias} verdict');
    const positionCall = d.indexOf('planLegDrawing(l, side, acct)');
    assert.ok(positionCall > 0, 'the verdict-side plan must go through planLegDrawing');
    assert.ok(gateCall > 0 && gateCall < positionCall,
      'the position tool must sit BELOW the planGate call, or a suppressed '
      + 'head-and-shoulders gets a shaded risk box instead of three suppressed lines');
    assert.ok(verdictGuard > 0 && verdictGuard < positionCall,
      'and BELOW the verdict filter, or a bilateral plan draws two opposing position boxes');
  });

  test('no bias at all still draws everything', () => {
    // `patterns_draw` is a tool the owner calls to SEE the patterns. Narrowing it to
    // one by default would answer a different question than the one asked. Only an
    // explicit NEUTRAL — a verdict, not the absence of one — collapses to the best.
    assert.match(src('src/core/patterns_draw.js'), /verdict === 'NEUTRAL' && candidates\.length > 1/);
  });

  // ── P2.4 (2026-07-30) — the max-age cutoff for drawn geometry ──────────────

  test('stale geometry is excluded BEFORE anything selects or draws', () => {
    /**
     * A confirmed pattern 45 bars old drew at full weight: `patternRank` puts
     * recency THIRD, so age only ever broke a tie between two patterns competing
     * for one slot — it never excluded one. P2.3 made the oldest shapes start
     * ageing out EMERGENTLY (a denser pivot backbone stopped surfacing a 41-bar-old
     * inverse head-and-shoulders inside the 300-bar scan), which is the wrong kind
     * of fix: silent, and it moves whenever the smoothing bandwidth moves.
     *
     * The ORDER is the contract. `planPatternDrawings` collapses a NEUTRAL verdict
     * to the single best-ranked candidate, and a stale CONFIRMED pattern outranks a
     * fresh forming one — so filtering afterwards would hand NEUTRAL a stale winner
     * and then delete it, drawing nothing while a live shape sat unused.
     */
    const d = src(DRAW);
    assert.match(d, /export const MAX_PATTERN_AGE_BARS = 21;/,
      'the default must be a named exported constant, not a literal buried in the drawer');
    assert.match(d, /export function patternAgePlan/,
      'the decision must be PURE — a display rule that needs a chart to test is untested');
    assert.match(d, /max_pattern_age_bars = MAX_PATTERN_AGE_BARS,/,
      'and drawFindings must take it as an option, defaulting to the constant');
    assert.match(d, /const agePlan = patternAgePlan\(stable, max_pattern_age_bars\)/);

    const ageFilter = d.indexOf('patternAgePlan(stable, max_pattern_age_bars)');
    const selection = d.indexOf('planPatternDrawings(agePlan.fresh');
    const geometry = d.indexOf('drawPatternGeometry(p, bars, group, put, hline)');
    assert.ok(ageFilter > 0 && ageFilter < selection,
      'the age filter must run BEFORE the selector, or NEUTRAL picks a stale winner');
    assert.ok(selection < geometry, 'and both before anything is drawn');

    // Nothing is deleted — what was withheld is reported, the same contract the
    // bias filter already has.
    assert.match(d, /const patternsSkipped = agePlan\.stale\.concat\(plan\.skipped\)/,
      'stale patterns must reach patterns_skipped alongside the bias-filtered ones');
    assert.match(d, /drawn\.pattern_age = \{/,
      '"the cutoff excluded nothing" and "the cutoff did not run" must be distinguishable');
  });

  test('a stale pattern takes its trade-plan legs with it', () => {
    /**
     * Same rule the bias filter has: "a plan whose pattern was not drawn cannot
     * leave an orphaned stop and target behind." Geometry alone is the confusing
     * half of both options — the shape is gone from the chart and three bright
     * lines from it are still on it.
     *
     * The stale set is checked SEPARATELY from `drawnPatterns` on purpose. That
     * guard reads `drawnPatterns.size && ...`, which fails OPEN when nothing was
     * drawn at all — and "every candidate was stale" is exactly the case that
     * empties it.
     */
    /**
     * P2.4 review (2026-07-30): the rules moved into the pure `planGate`, whose
     * BEHAVIOUR — including the fails-open case with an empty drawn set — is
     * pinned by calls in tests/drawing_natives.test.js. Here: the map is built
     * from the age plan, the gate is called inside the plan loop, and the call
     * precedes every drawing decision.
     */
    const d = src(DRAW);
    assert.match(d, /const stalePatterns = new Map\(agePlan\.stale\.map/);
    assert.match(d, /stalePatterns\?\.has\(tp\.pattern\)/, 'the stale rule must live in planGate');
    assert.match(d, /past the \$\{s\.max_age_bars\}-bar max age/,
      'the suppression reason must carry the threshold, not just the fact');

    const staleRule = d.indexOf('stalePatterns?.has(tp.pattern)');
    const notDrawnRule = d.indexOf('!drawnPatterns.has(tp.pattern)');
    const gateCall = d.indexOf('const gate = planGate(tp, stalePatterns, drawnPatterns)');
    const positionCall = d.indexOf('planLegDrawing(l, side, acct)');
    const entryLine = d.indexOf('text: `ENTRY ${side}');
    assert.ok(gateCall > 0 && gateCall < positionCall,
      'the gate must sit ABOVE the position tool, or a suppressed shape gets a shaded risk '
      + 'box instead of three suppressed lines — the ALM failure in a new costume');
    assert.ok(gateCall < entryLine, 'and above the three-line fallback');
    assert.ok(staleRule > 0 && notDrawnRule > 0 && staleRule < notDrawnRule,
      'inside planGate the stale rule must come FIRST — the not-drawn rule fails open '
      + 'when drawnPatterns is EMPTY, which is exactly the all-stale case');
  });

  test('the cutoff reaches the workflow by DEFAULT — no caller has to remember it', () => {
    /**
     * "A step you have to REMEMBER is a step that will eventually not happen." The
     * option exists so it can be turned OFF deliberately; it must not need turning
     * ON. `ticker_analyze` passes `{ clear_scope, bias, earnings }` and the Sunday
     * review goes through `analyzeTicker`, so both inherit the default — neither
     * file needed a change, and neither may quietly opt out.
     */
    for (const f of [ORCH, 'scripts/sunday-review.js', 'scripts/morning-screen.js']) {
      assert.ok(!/max_pattern_age_bars/.test(src(f)),
        `${f} must inherit the default rather than restating it — a second copy of the number drifts`);
    }
    /**
     * Asserted key by key rather than as a whole literal.
     *
     * P3.2/P3.4 (2026-07-30) added `auto_alerts` to that object and this assertion
     * failed — while its own message said an added option "is additive and cannot
     * break it". A regex over the entire literal makes the additive case a
     * breaking one, which is the opposite of what it was written to protect.
     */
    const opts = src(ORCH).slice(src(ORCH).indexOf('{ clear_scope, bias:'));
    for (const key of ['clear_scope', 'bias: verdict\\?\\.bias \\?\\? null', 'earnings: earningsForDraw']) {
      assert.match(opts.slice(0, 200), new RegExp(key),
        `the analysis path must keep passing ${key} — the options object is additive, and a term that `
        + 'drops out of it fails silently');
    }
  });

  test('patterns_draw is ungated by CONSTRUCTION, not by an opt-out', () => {
    /**
     * The tool the owner calls to SEE the patterns must keep showing all of them,
     * including old ones. It reaches `planPatternDrawings` and `drawPatternGeometry`
     * directly and never touches `drawFindings`, so the cutoff cannot reach it — no
     * flag to pass, nothing to forget.
     */
    const t = src('src/tools/patterns.js');
    assert.ok(!/drawFindings/.test(t), 'patterns_draw must not route through the workflow drawer');
    assert.ok(!/max_pattern_age_bars|patternAgePlan/.test(t),
      'and must not grow its own copy of the cutoff');

    // The selector it shares with the workflow stays age-blind: `patternRank` ranks
    // BY recency and never excludes on it. Selecting and excluding are different
    // jobs, and putting the cutoff here would gate the inspection tool too.
    const sel = src('src/core/patterns_draw.js');
    assert.match(sel, /Number\(p\.bars_ago\) \?\? 1e9,/,
      'patternRank must still rank by recency');
    assert.ok(!/max_pattern_age|bars_ago >/.test(sel),
      'and must not acquire a threshold — patterns_draw shares this module and must stay ungated');
  });

  test('a definite negative ANSWER is not scored as a failure', () => {
    /**
     * Two cases surfaced on the first Sunday run, and both would have made every
     * affected ticker read INCOMPLETE:
     *
     *   NUKZ is an ETF, so it is not in sp500 + nasdaq + russell2000 and `screens`
     *   genuinely cannot run. That is a fact about the INSTRUMENT.
     *
     *   LRN passes no screen, so no catalogue strategy applies. That is the ANSWER,
     *   and for a held position it is a useful one.
     *
     * Neither showed on the morning screen, because every candidate there arrives BY
     * passing a screen. The Sunday list is whatever TA holds, so both fire constantly.
     */
    const t = src(ORCH);
    assert.match(t, /err\.notApplicable\s*\n?\s*\? \{ ok: false, not_applicable: true, reason: err\.message \}/,
      'section() must honour the flag');
    assert.match(t, /e\.notApplicable = true;/, 'and something must set it');
    // "passes no screen" RETURNS a verdict rather than throwing at all.
    assert.match(t, /verdict: 'passes no screen, so no catalogue strategy applies here'/);
    // An EMPTY scan is still a failure — the flag must not blur that.
    assert.match(t, /the scanner returned no rows at all — the scan itself failed/);
  });

  test('the flag must be set deliberately, never inferred', () => {
    // If any thrown error counted as not-applicable, a required section could be
    // silenced by anything that happened to fail — which destroys the score.
    const t = src(ORCH);
    assert.ok(!/catch \(err\) \{\s*results\[key\] = \{ ok: false, not_applicable: true/.test(t),
      'a bare throw must remain a failure');
  });

  test('a null taRow cannot take the whole drawing step down', () => {
    assert.match(src(DRAW), /if \(taRow && taRow\.stop != null/,
      'standalone analysis passes no portfolio row; the unguarded read killed geometry, channel '
      + 'and levels together');
  });

  test('the run is scored, so a skipped section cannot be silent', () => {
    assert.match(src(ORCH), /scoreAnalysis\(results\)/);
    assert.match(src('src/core/analysis_contract.js'), /NOT RUN/);
  });

  test('a section is scored on its CONTENT when the block can be empty', () => {
    /**
     * `assess` with no benchmark returns `{ leadership: null, benchmark: 'AMEX:SPY' }`
     * — an OBJECT. The block-existence loop marked that OK, so relative_strength read
     * as "ran and found nothing" on every analysis for which no SPY had been fetched.
     */
    const t = src(ORCH);
    assert.match(t, /results\.relative_strength = a\.relative_strength\?\.leadership/,
      'relative_strength must be scored on leadership, not on the block existing');
    assert.match(src('src/core/analysis_contract.js'), /key: 'benchmark'/,
      'the benchmark fetch is its own section, so a failed SPY load names itself');
  });

  test('the entry-hypothesis guards are still wired in', () => {
    assert.match(src(ORCH), /entryHypothesis\(\{/);
    const e = src('src/core/entry_hypothesis.js');
    for (const guard of ['MIN_STOP_ATR', 'chasing_warning', 'catalyst_conflict']) {
      assert.match(e, new RegExp(guard), `${guard} is the reason this is kept beside trade_plans`);
    }
  });

  test('one horizontal line per PRICE — every level writer goes through hline', () => {
    /**
     * Clearing first is not enough on its own. Each block below draws its own
     * levels — primaries, zone boundaries, the TA stop, every leg of every trade
     * plan — and they land on top of each other. On TIGO the primary resistance
     * (100.415) and the supply-zone top (100.08) sat 0.33% apart: two lines, two
     * labels, one level. Seven horizontal lines on a chart the primary-level work
     * had reduced to two, which reads exactly like the clear having failed.
     */
    const d = src(DRAW);
    assert.match(d, /const hline = async \(price, opts, label/, 'the deduping helper must exist');
    assert.match(d, /merged_levels/, 'a merge must be reported, never silent');

    // No level writer may bypass it. The three legitimate direct calls are inside
    // drawPatternGeometry (pattern necklines) and the helper's own implementation.
    const direct = [...d.matchAll(/drawShape\(\{ shape: 'horizontal_line'/g)].length;
    assert.ok(direct <= 3,
      `${direct} horizontal lines are drawn directly instead of through hline — each one can `
      + 'collide with a level another block already drew');
    assert.ok(d.split('await hline(').length - 1 >= 8,
      'primaries, both zones, entry, stop, target, VCP pivot and the TA stop must all dedupe');

    /**
     * ADAPTED for the native position tool.
     *
     * The intent — one mark per PRICE — now has a writer that draws no line at
     * all. A position box already depicts entry, stop and target, so those three
     * prices must be CLAIMED in `drawnPrices` even though nothing went through
     * `hline`; otherwise the VCP pivot or TA's stop lands a second mark on a price
     * the box is already showing, which is the TIGO collision in a new costume.
     */
    assert.match(d, /drawnPrices\.push\(\{ price: r2\(price, 4\), label: `\$\{role\} \$\{tag\} \(position tool\)` \}\)/,
      'the position tool must claim its three prices in the dedupe set');
  });

  test('chart reads still stamp the symbol they read', () => {
    assert.match(src('src/core/structure.js'), /return \{ bars, symbol:/);
    assert.match(src('src/tools/divergence.js'), /return \{ bars, symbol:/);
  });
});

/**
 * The native TradingView tools the drawer adopted on 2026-07-30.
 *
 * All three replace hand-built geometry with ONE entity, and all three are
 * source contracts for the same reason the rest of this file is: the wiring is
 * what drifts, and every failure mode here is silent.
 */
describe('native shapes — one entity where there were several', () => {
  test('the verdict-side plan is a position tool, with the three lines as fallback', () => {
    /**
     * `position_tool.js` existed, worked and was registered the whole time the
     * unified drawer was putting three horizontal lines on the chart instead. The
     * native tool shades risk and reward, is draggable, and recomputes the size
     * itself — which three static lines cannot do.
     *
     * The FALLBACK is the part that must not rot: on a machine with no configured
     * account there is nothing to size the box with, and inventing a number is the
     * failure position_size_constrained was fixed for.
     */
    const d = src(DRAW);
    assert.match(d, /import \{ drawPosition \} from '\.\/position_tool\.js'/,
      'the shared drawer must call the position tool, not re-implement it');
    assert.match(d, /await put\(\(\) => drawPosition\(\{/);
    assert.match(d, /import \{ accountSettings \} from '\.\/rules\.js'/,
      'account size and risk come from rules.json — never from a literal');
    assert.ok(!/account_size: \d/.test(d), 'an account size hard-coded here is an invented one');
    assert.match(d, /export function planLegDrawing/,
      'the position-or-lines decision must be PURE, so both paths are testable without a chart');
    // The fallback still writes ENTRY / STOP / TARGET, the only text-bearing form
    // of a trade plan and therefore the only one the orphan sweep can recover.
    for (const re of [/text: `ENTRY \$\{side\}/, /text: `STOP \$\{l\.stop\}/, /text: `TARGET \$\{l\.target\}/]) {
      assert.match(d, re, 'the three-line fallback must survive — it runs whenever the account is unset');
    }
  });

  test('the channel is ONE parallel_channel, not two trend lines', () => {
    /**
     * Two independent trend lines described a channel without being one: dragging
     * either edge broke the parallelism the measurement asserts, and clearing one
     * left the other. Probed 3 points asked, 3 landed.
     */
    const d = src(DRAW);
    assert.match(d, /shape: 'parallel_channel'/);
    assert.ok(!/text: `\$\{channel\.pattern\} (?:upper|lower)`/.test(d),
      'the two separate boundary lines must be gone');
    assert.match(src('src/core/orphans.js'), /\^\(\?:\$\{PAT\}\) \(\?:upper\|lower\)\$/,
      'and their signature must STAY — signatures are append-only, and every chart drawn before '
      + 'today still carries those labels');
  });

  test('head and shoulders is one native entity, with a hard 7-pivot floor', () => {
    /**
     * The old "native multipoint tools place two points and stay armed" conclusion
     * was triangle_pattern-specific: head_and_shoulders landed 7 of 7 in the same
     * session triangle_pattern landed 2 of 5. Given fewer points than it declares,
     * a pattern tool places what it has and leaves the drawing cursor LIVE — so
     * the floor is not a nicety.
     */
    const d = src(DRAW);
    assert.match(d, /shape: 'head_and_shoulders',\s*\n\s*points: seven/);
    assert.match(d, /if \(pv\.length >= 7\)/, 'the 7-pivot floor must gate the native tool');
    assert.match(d, /\} else if \(pv\.length >= 2\) \{/, 'and fewer pivots must fall back to leg lines');
    assert.match(src('src/core/drawing.js'), /keyboard\(\{ key: 'Escape' \}\)/,
      'the Escape disarm stays — a synthetic KeyboardEvent is ignored (isTrusted false)');
    assert.match(src('src/core/drawing.js'), /triangle_pattern: 5,\s*\/\/ LineToolTrianglePattern — BROKEN/,
      'triangle_pattern must stay marked broken, or head_and_shoulders working invites a re-try');
  });

  test('a multipoint create is settle-verified, not slept through', () => {
    /**
     * The fixed 500ms wait was a guess a probe caught being wrong: a shape that
     * resolves after the capture window is never recorded, and a multipoint shape
     * carries no text — so it is invisible to BOTH the registry clear and the
     * orphan sweep. That is the 545-stale-shapes failure, one drawing at a time.
     */
    const dr = src('src/core/drawing.js');
    assert.ok(!/setTimeout\(r, 500\)/.test(dr), 'the fixed 500ms multipoint sleep must be gone');
    assert.match(dr, /export const MULTIPOINT_SETTLE = \{ interval_ms: \d+, budget_ms: \d+ \}/);
    assert.match(dr, /settledId = await settleForNewId\(apiPath, before\)/,
      'the id must be captured BEFORE the Escape, or a late create escapes capture');
    assert.match(dr, /\|\| settledId \|\| null/,
      'and a polled id must beat returning null — an unidentified shape is an untrackable one');
  });

  test('the fibonacci block is DRAWN, and gated on the block itself', () => {
    /**
     * `assess()` computed a fibonacci block from the day it existed and nothing
     * drew it — the reader got "retraced 45%, in the golden zone" and no way to
     * see where. The anchor comes from `assessment.js` so the grid sits on the
     * SAME impulse the percentage describes; deriving it again in the drawer is
     * the two-copies-drift failure this whole file exists to prevent.
     */
    const d = src(DRAW);
    assert.match(d, /shape: 'fib_retracement'/);
    assert.match(d, /export function fibDrawPlan/,
      'the gate must be PURE, so "does this retracement deserve a grid" is testable without a chart');
    assert.match(d, /const fibPlan = fibDrawPlan\(a\.fibonacci\)/,
      'and it must read assess()\'s own block, not re-measure the swings');
    const a = src('src/core/assessment.js');
    assert.match(a, /anchor: fibAnchor/, 'assess() must carry the anchor times');
    for (const k of ['retraced_pct:', 'in_golden_zone:', 'targets:', 'targets_refused_reason:']) {
      assert.ok(a.includes(k), `${k} must survive — the fibonacci block is published in the 2.0 schema`);
    }
  });

  test('the elliott count is drawn ONLY on agreement', () => {
    /**
     * A rule-valid count exists on 70.5% of random walks, and `surveyCounts`
     * returns every count the rules allow precisely so that no single one is
     * presented as THE count. Drawing one is the strongest presentation there is,
     * so the only one drawn is the count every sensitivity agreed on.
     */
    const d = src(DRAW);
    assert.match(d, /shape: 'elliott_impulse_wave'/);
    assert.match(d, /export function elliottDrawPlan/);
    assert.match(d, /if \(distinct > 1\)/, 'disagreement must be an explicit refusal, not a fall-through');
    assert.match(src('src/core/assessment.js'), /if \(\(ell\?\.distinct_recent_counts \?\? 0\) !== 1\) return null;/,
      'assess() must only carry the pivots when the survey itself reports agreement');
  });

  test('the earnings date reaches the drawer, and a PAST one is never drawn', () => {
    /**
     * `days_to_earnings` answers "does it report inside my hold". A LINE needs a
     * point on the time axis, which only the date gives — so the date is threaded
     * through rather than the distance.
     */
    const o = src(ORCH);
    assert.match(o, /const earningsForDraw = earnings\?\.earnings_date/,
      'the DATE must be threaded through, not just days_until');
    assert.match(o, /earnings: earningsForDraw/, 'and it must reach drawFindings');
    const d = src(DRAW);
    assert.match(d, /shape: 'vertical_line'/);
    assert.match(d, /export function earningsLinePlan/);
    assert.match(d, /if \(days < 0\)/,
      'a past earnings date must be refused — behind price it is history, and on a chart it reads '
      + 'identically to a live catalyst');
    assert.match(src('src/core/orphans.js'), /\^earnings \\\\d\{4\}-\\\\d\{2\}-\\\\d\{2\}/,
      'the line carries TEXT, so its format must be registered or it leaks a permanent orphan');
    /**
     * The probe result belongs beside the shape catalogue, the same way
     * triangle_pattern's failure does. The open question was whether a one-point
     * shape can be placed past the end of the series; it can, and TradingView
     * snaps it to the next session. Recorded so the next reader does not re-probe
     * it, or "fix" it by clamping to the last bar.
     */
    assert.match(src('src/core/drawing.js'), /vertical_line BEYOND the last bar: it works/,
      'the future-time probe result must be recorded in drawing.js beside the other shape verdicts');
    assert.match(src('src/core/drawing.js'), /callout\s+2\/2 points, text READ BACK VERBATIM/,
      'and so must the fact that a TWO-point create keeps its text — the no-text rule is about creates '
      + 'with MORE than two points, and conflating them would make the callout look unusable');
  });

  test('the volume profile is OPT-IN, and not enabled from the analysis path', () => {
    // A pane-wide overlay on twenty machine-selected charts is not a level. The
    // acceptance is "rendered natively on request".
    assert.match(src(DRAW), /volume_profile = false,/, 'it must default OFF');
    assert.match(src(DRAW), /shape: 'fixed_range_volume_profile'/);
    assert.ok(!/volume_profile: true/.test(src(ORCH)),
      'ticker_analyze must not turn it on yet');
  });

  test('long labels come OFF the line, and the line keeps its text', () => {
    /**
     * The ALM/MTSI overprinting is text-on-hline collision at the right price
     * scale, which the `hline` dedupe cannot fix — those are different prices
     * that each deserve a line. So the line stays and the TEXT moves into a
     * callout, probed 2/2 with its text reading back verbatim.
     *
     * Two properties are load-bearing and both are silent when broken:
     * the text is passed to the callout UNCHANGED (every one of those strings is
     * an orphan-sweep signature), and the line keeps its text with the label
     * merely hidden, so it stays sweepable too.
     */
    const d = src(DRAW);
    assert.match(d, /export function labelPlacements/,
      'the collision logic must be PURE — a placement rule that needs a chart to test is untested');
    assert.match(d, /const place = labelPlacements\(labelQueue, atr\)\.at\(-1\)/,
      'and the drawer must USE it, or the tested function is not the shipped one');
    assert.match(d, /shape: 'callout'/);
    assert.match(d, /text: opts\?\.text \?\? ''/,
      'the callout must carry the label CONTENT unchanged — rewording one to fit a box strands '
      + 'every drawing that carries the old wording');
    assert.match(d, /withOverrides\(opts, \{ showLabel: false \}\)/,
      'the line keeps its text with the label hidden: findOrphans matches the text PROPERTY, so a '
      + 'stripped line would be as unsweepable as the textless natives, for no gain');
    assert.match(d, /labels_offset/, 'what moved must be reported, never silent');
    assert.match(src('src/core/orphans.js'), /\^\[SR\] \$\{NUM\} \\\\\(\$\{NUM\}%\\\\\) -/,
      'the level label WITH its evidence suffix must be registered — measured 2026-07-30, isMcpText '
      + 'returned false on it, so every primary level drawn with a reason was invisible to the sweep');
  });

  test('the textless natives say so, and lean on the GROUP clear', () => {
    /**
     * `findOrphans` classifies a shape with no text as FOREIGN and never touches
     * it — correct, since most hand-drawn shapes are unlabelled. But the position
     * tool and the parallel_channel cannot carry text at all (a non-empty `text`
     * makes a multipoint create silently draw nothing, and setProperties reads back
     * null), so neither is recoverable by signature. The mitigation is the group,
     * and the mitigation has to be written down where the next person will look.
     */
    const d = src(DRAW);
    assert.match(d, /group,\s*\n\s*\}\), `position \$\{side\} \$\{tag\}`\)/,
      'the position tool must be drawn INTO drawFindings\' group, or clear_scope mcp misses it');
    assert.match(d, /carries no text/i, 'the cost must be stated beside the code that pays it');
    assert.match(src('src/core/orphans.js'), /else if \(isMcpText\(s\.text, \{ sources \}\)\) orphans\.push/,
      'no text means no match means never swept — the behaviour this depends on');
    assert.match(src('src/core/position_tool.js'), /symbol: await drawing\.currentSymbol\(\)/,
      'and the registry entry must be symbol-scoped, or prune leaves it forever');
  });
});

describe('the three sections TA found dead — producer call shapes (2026-07-31)', () => {
  /**
   * All three failed the same way: the orchestrator handed a core the wrong
   * first argument, and each core's GRACEFUL unavailable path turned the
   * producer bug into a plausible data condition — "got 0 swings", "got 0
   * bars", "no rows" — on rows whose siblings read 299 bars. The completeness
   * score counted them as ran, because a definite negative is a real answer.
   * These pin the call shapes to the ones the registered TOOLS use.
   */
  const t = src(ORCH);

  test('pivot_trail receives SWINGS through the backbone chain, never bars', () => {
    assert.match(t, /classifyStructure\(alternateSwings\(findSwings\(bars, \{ lookback \}\)\)\)/);
    assert.match(t, /stops\.pivotTrail\(labelled\.swings,/);
    assert.ok(!t.includes('stops.pivotTrail(bars'),
      'bars have no .price — the filter counts 0 and the section dies gracefully');
  });

  test('stage_plan receives {long_bars, short_bars} with the weekly gate, never a positional array', () => {
    assert.match(t, /resampleBars\(bars, 'week'\)/);
    assert.match(t, /agg\.partial_last_bar \? agg\.bars\.slice\(0, -1\) : agg\.bars/);
    assert.match(t, /stages\.stagePlan\(\{ long_bars: gateBars, short_bars: bars \}\)/);
    assert.ok(!t.includes('stages.stagePlan(bars)'),
      'destructuring an array yields undefined long_bars — "got 0" on 299-bar rows');
  });

  test('strategy criteria get the STRUCTURE operands — pullback_pct is not permanently unknown', () => {
    assert.match(t, /buildStructureContext\(bars, \{ lookback \}\)/);
    assert.match(t, /buildContext\(bars, \{ structure: structure\.available \? structure : null \}\)/);
    assert.ok(!t.includes('buildContext(bars, {})'),
      'an empty options object leaves five clause families unresolvable — the lesson contextForChart already documents');
  });

  test('an intraday strategy on a daily chart is NOT APPLICABLE, never a wall of unknowns', () => {
    assert.match(t, /thin\.execution === 'intraday' && !ctx\.intraday/);
    assert.match(t, /not_applicable_on_this_timeframe/,
      'undefined-by-construction and unavailable are different statements');
  });

  test('short_interest fetches ROWS before building the series, never passes the ticker string', () => {
    assert.match(t, /finra\.fetchSeries\(bare, \{ periods: 6, asOf, dataset: 'consolidated' \}\)/);
    assert.match(t, /finra\.buildSeries\(rows, \{ asOf, bars, lastPrice: px, periods: 6 \}\)/);
    assert.ok(!t.includes('finra.buildSeries(bare'),
      "Array.isArray('CORT') is false — every row read as having no short-interest data");
  });
});

describe('sizing follows the owner\'s rule: the budget IS TA\'s max heat (2026-07-31)', () => {
  const t = src(ORCH);
  test('the budget derives from TA equity × max_heat_pct, with rules.json as the stated fallback', () => {
    assert.match(t, /heat\.equity_basis \* \(heat\.max_heat_pct \/ 100\)/);
    assert.match(t, /taBudget \?\? cfg\.account_size/);
    assert.match(t, /'ta_max_heat' : 'rules_json_fallback'/,
      'the basis must be NAMED in output — a fallback that reads like the real thing is the walls bug again');
  });
  test('heat is computed BEFORE sizing, so the derivation cannot read the temporal dead zone', () => {
    const heatIdx = t.indexOf("const heat = await section(results, 'portfolio_heat'");
    const sizingIdx = t.indexOf("await section(results, 'sizing'");
    assert.ok(heatIdx > 0 && sizingIdx > heatIdx,
      'sizing references `heat`; if it ever moves above portfolio_heat the section dies at runtime');
  });
  test('remaining heat room is reported, and a breach says so', () => {
    assert.match(t, /remaining_heat/);
    assert.match(t, /EXCEEDS the remaining heat room/);
  });
});

describe('the cycle reaches the report AND the chart through the one drawer (2026-08-02)', () => {
  /**
   * The owner's four-claim check: scanner in the screens, cycle in the analysis,
   * boundaries on the chart, all of it in the Sunday report. The last three are
   * one wiring — a `cycle` section in the orchestrator, threaded into
   * drawFindings, executed by the SAME stageDrawPlan/drawStageHistory pair the
   * stage_draw tool uses. A second drawer beside the tool's would be the
   * ticker_analyze hand-rolling defect again.
   */
  const t = src(ORCH);
  const d = src('src/core/assessment_draw.js');

  test('the orchestrator has a cycle section built from stageHistory(bars)', () => {
    assert.match(t, /section\(results, 'cycle'/);
    assert.match(t, /cycleHistory = stageHistory\(bars\)/);
  });

  test('the full readings stay LOCAL — the report gets the projection, not 300 rows per ticker', () => {
    assert.match(t, /let cycleHistory = null/);
    assert.match(t, /\(h\.transitions \|\| \[\]\)\.slice\(-6\)/,
      'the section must project: last transitions, not the whole reading series');
  });

  test('the history is THREADED into drawFindings, and the drawer reuses the tool\'s own pair', () => {
    assert.match(t, /cycle: cycleHistory/);
    assert.match(d, /stageDrawPlan\(cycle, \{/);
    assert.match(d, /drawStageHistory\(cyclePlan, group, put, drawing\.drawShape\)/,
      'boundaries must go through the registered put/drawShape chain — same signatures, same registry');
  });

  test('the section carries its own floor and forward-test verdict in the payload', () => {
    assert.match(t, /43-52% of random walks/);
    assert.match(t, /unpaid at the swing horizon/,
      'a state machine that reads as a signal without its measured floor is the stage_plan mistake again');
  });

  test('the contract row is advisory — an intraday 5-minute chart without a cycle is not a broken analysis', () => {
    const c = src('src/core/analysis_contract.js');
    assert.match(c, /key: 'cycle', required: false/);
  });
});

describe('native groups ride the drawer — organized after drawing, isolated from it (2026-08-02)', () => {
  /**
   * The owner's toggle request: one Object Tree row per category, eye icon per
   * row. The organize step must see EVERY shape (so it runs after the last
   * draw block) and must never take an analysis down (a grouping error is a
   * report, not a throw). The removeGroup trap lives in draw_visibility's own
   * suite; what this pins is the drawer's wiring.
   */
  const d = src('src/core/assessment_draw.js');

  test('organize runs after the cycle block and before ALERTS', () => {
    const cycleIdx = d.indexOf("drawStageHistory(cyclePlan, group, put, drawing.drawShape)");
    const orgIdx = d.indexOf('organizeNativeGroups');
    const alertIdx = d.indexOf('ALERTS — the only thing here');
    assert.ok(cycleIdx > 0 && orgIdx > cycleIdx, 'organize must come after the last draw block');
    assert.ok(alertIdx > orgIdx, 'and before alerts — alerts are the one irreversible step and stay last');
  });

  test('a grouping failure is a field, never a throw', () => {
    const block = d.slice(d.indexOf('if (native_groups)'), d.indexOf('ALERTS — the only thing here'));
    assert.match(block, /catch \(e\) \{\s*drawn\.native_groups = \{ error: e\.message \}/);
  });

  test('the option defaults ON, with the persistence probe as its licence', () => {
    assert.match(d, /native_groups = true,/);
    assert.match(d, /persist across a\s+\* symbol round-trip/,
      'the default carries its evidence — flip it off and the doc string goes stale with it');
  });
});
