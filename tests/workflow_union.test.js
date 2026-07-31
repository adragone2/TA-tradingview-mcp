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
    assert.match(d, /planPatternDrawings\(stable/, 'duplicate shapes must be collapsed');
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
    assert.match(d, /planPatternDrawings\(stable, \{ max_patterns: 6, bias \}\)/);
    assert.match(d, /const wantLeg = \{ BULLISH: 'long', BEARISH: 'short' \}/,
      'trade-plan legs must be filtered too — geometry alone leaves the contradicting stop and target');
    assert.match(d, /plans_suppressed/, 'what was withheld must be reported, never silently dropped');
    // A plan whose pattern was not drawn must not draw its levels either.
    assert.match(d, /drawnPatterns\.size && tp\.pattern && !drawnPatterns\.has\(tp\.pattern\)/);

    /**
     * ADAPTED for the native position tool.
     *
     * The intent is unchanged — a plan whose pattern was not drawn must not put a
     * stop and a target on the chart — but the plan is now drawn as ONE
     * `long_position` / `short_position` box rather than three horizontal lines,
     * and a box placed above both guards would reintroduce exactly the ALM
     * failure in a shape the line-based assertions cannot see.
     *
     * So the ordering is asserted directly: both `continue` guards must precede
     * the position-tool decision inside the same loop.
     */
    const patternGuard = d.indexOf('!drawnPatterns.has(tp.pattern)');
    const verdictGuard = d.indexOf('leg contradicts the ${bias} verdict');
    const positionCall = d.indexOf('planLegDrawing(l, side, acct)');
    assert.ok(positionCall > 0, 'the verdict-side plan must go through planLegDrawing');
    assert.ok(patternGuard > 0 && patternGuard < positionCall,
      'the position tool must sit BELOW the pattern-was-not-drawn guard, or a suppressed '
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
