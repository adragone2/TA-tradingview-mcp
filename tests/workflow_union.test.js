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
  });

  test('no bias at all still draws everything', () => {
    // `patterns_draw` is a tool the owner calls to SEE the patterns. Narrowing it to
    // one by default would answer a different question than the one asked. Only an
    // explicit NEUTRAL — a verdict, not the absence of one — collapses to the best.
    assert.match(src('src/core/patterns_draw.js'), /verdict === 'NEUTRAL' && candidates\.length > 1/);
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
  });

  test('chart reads still stamp the symbol they read', () => {
    assert.match(src('src/core/structure.js'), /return \{ bars, symbol:/);
    assert.match(src('src/tools/divergence.js'), /return \{ bars, symbol:/);
  });
});
