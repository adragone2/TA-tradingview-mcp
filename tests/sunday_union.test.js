import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * The Sunday review runs the SAME analysis workflow as everything else.
 *
 * It used to call `assess()` + `ourAssessment()` + `drawFindings()` directly, which
 * gave it the 28 measurement blocks and NONE of the 23 context sections
 * `analyzeTicker` adds — no portfolio heat, no earnings calendar, no pivot trail, no
 * short interest, no completeness score. The review of real positions was thinner
 * than the morning candidate screen.
 *
 * Every assertion below is a term that a naive adoption would have dropped. Two of
 * them WOULD have been dropped — they were found by reading the call site, not by a
 * test failing, which is why they are pinned here now.
 */
const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');
const SUNDAY = 'scripts/sunday-review.js';
const ORCH = 'src/core/ticker_analyze.js';

describe('the Sunday review is on the one workflow', () => {
  test('it calls analyzeTicker', () => {
    assert.match(src(SUNDAY), /await analyzeTicker\(\{/);
  });

  test('and no longer calls the three pieces directly', () => {
    /**
     * Importing them again would be a second path to the same place. `analyzeTicker`
     * calls all three in the right order AND scores the result; a direct call skips
     * the scoring, which is how a missing section became invisible here.
     */
    const s = src(SUNDAY);
    assert.ok(!/^import \{ assess, ourAssessment/m.test(s), 'assess/ourAssessment must not be re-imported');
    assert.ok(!/^import \{ drawFindings \}/m.test(s), 'drawFindings must not be re-imported');
    assert.ok(!/\bassess\(bars/.test(s), 'no direct assess() call');
    assert.ok(!/await drawFindings\(/.test(s), 'no direct drawFindings() call');
  });

  test('CATALYST_EVIDENCE survives, because validateTa is Sunday-only', () => {
    // The one thing here that is genuinely not part of the shared analysis:
    // analyzeTicker says what the chart shows, validateTa says whether that
    // supports what TA wants done.
    assert.match(src(SUNDAY), /import \{ CATALYST_EVIDENCE \}/);
    assert.match(src(SUNDAY), /row\.ta_validation = validateTa\(/);
  });
});

describe('the two terms a naive adoption would have dropped', () => {
  test("TA's own stop is still drawn — ta_row is passed through", () => {
    /**
     * `analyzeTicker` hardcoded `null` for drawFindings' third argument. Correct for
     * a standalone analysis, which has no portfolio row — and a silent regression the
     * moment a caller that HAS one adopts it. Swapping Sunday over without this would
     * have stopped drawing TA's stop on all ~48 charts, with nothing reporting it.
     */
    assert.match(src(ORCH), /ta_row = null, draw_group = null,/, 'the orchestrator must accept them');
    assert.match(src(ORCH), /symbol, a, ta_row, verdict\?\.bias/, 'and pass ta_row to drawFindings');
    assert.match(src(SUNDAY), /ta_row: item\.taRow/, 'Sunday must supply it');
  });

  test('the drawing group stays sunday-<TICKER>', () => {
    /**
     * `clear_scope: 'mcp'` clears the NAMED group. The Sunday run has drawn into
     * `sunday-<TICKER>` for months; taking the orchestrator's `analysis-<SYMBOL>`
     * default would have left every previous week's shapes uncleared, still tracked,
     * and invisible to the group clear meant to remove them.
     */
    assert.match(src(ORCH), /draw_group \|\| `analysis-\$\{/);
    assert.match(src(SUNDAY), /draw_group: `sunday-\$\{/);
    assert.match(src('docs/sunday-review-schema.md'), /sunday-<TICKER>/,
      'and the schema still advertises that pattern to consumers');
  });

  test('the unattended run narrows the clear, like the morning batch', () => {
    // ~48 charts of the owner's own positions, at 08:00 on a Sunday, with nobody
    // present to be asked about a walls overlay or a hand-drawn line.
    assert.match(src(SUNDAY), /clear_scope: 'mcp'/);
  });
});

describe('the batch pays for the shared data once', () => {
  test('scanner, groups, TA context and the portfolio are fetched before the loop', () => {
    // Without this, analyzeTicker repeats two 2,000-row scans, a TA context call and
    // a portfolio read for every one of ~48 tickers.
    const s = src(SUNDAY);
    for (const k of ['scanner_rows', 'group_rows', 'ta_context', 'portfolio_response', 'benchmark_bars']) {
      assert.match(s, new RegExp(`shared\\.${k}|${k}:`), `${k} must be shared across the batch`);
    }
    // Fetched BEFORE the per-ticker loop, not inside it.
    assert.ok(s.indexOf('shared.scanner_rows') < s.indexOf('for (const item of queue)'),
      'the shared fetch must precede the loop');
  });

  test('a shared fetch failure degrades a section, not the run', () => {
    const s = src(SUNDAY);
    const block = s.slice(s.indexOf('const shared ='), s.indexOf('for (const item of queue)'));
    assert.ok((block.match(/catch \(e\)/g) || []).length >= 4,
      'every shared fetch needs its own catch — one TA outage must not end the review');
  });
});

describe('the 2.0 schema', () => {
  test('the version is bumped and the doc agrees', () => {
    assert.match(src(SUNDAY), /SCHEMA_VERSION = '2\.0'/);
    assert.match(src('docs/sunday-review-schema.md'), /"schema_version": "2\.0"/);
  });

  test('the doc carries a migration table, because TA imports this', () => {
    /**
     * The owner's condition for accepting a breaking change: "it is ok as long as you
     * give me a prompt for TA so it can fix the importer." A moved key with no
     * migration note is how a consumer starts rendering nulls and its own tests pass.
     */
    const d = src('docs/sunday-review-schema.md');
    assert.match(d, /BREAKING change/);
    for (const moved of ['analysis.assessment', 'analysis.verdict', 'analysis.drawings']) {
      assert.ok(d.includes(moved), `the migration table must name ${moved}`);
    }
  });

  test('the report is assembled from the new key path', () => {
    // `our_view` moved to `analysis.verdict`; a summary still reading the old path
    // would count zero of everything and look like a flat market.
    const s = src(SUNDAY);
    assert.match(s, /t\.analysis\?\.verdict\?\.bias === 'BULLISH'/);
    assert.match(s, /completeness_summary/, 'and the run must report how complete it was');
  });
});

describe('all of TA, with exclusions stated rather than silent', () => {
  test('holdings are IN by default — the flag is now an opt-OUT', () => {
    /**
     * `--holdings` was opt-in and the scheduled task never passed it, so the weekly
     * portfolio review silently skipped every position TA was not flagging for
     * action. Measured 2026-07-30: TA held 73, the actionable list was 53, and 35
     * holdings were never queued — ANET, AVGO, VOO, VXUS, ICVT, COPX, HYDR, ILIT,
     * RING, SLVP among them.
     *
     * The owner's rule: "The sunday routine analyzes all TA tickers period. no
     * exclusions." An opt-in flag on a scheduled job IS an exclusion by default.
     */
    assert.match(src(SUNDAY), /const INCLUDE_HOLDINGS = !args\.includes\('--no-holdings'\)/);
  });

  test('crypto is excluded — and never charted, because charting it lies', () => {
    /**
     * `BTC-USD` handed to TradingView does not fail. It resolves to the SPREAD
     * `CRYPTOCAP:BTC-BATS:USD`, returns 300 bars, and every detector runs happily on
     * a synthetic series that is not the price of Bitcoin. Verified live.
     */
    const m = src('src/core/ta_symbols.js');
    assert.match(m, /CRYPTOCAP:BTC-BATS:USD/, 'the trap must be documented where the decision is made');
    assert.match(m, /chartable: false/);
    assert.match(src(SUNDAY), /if \(r\.chartable\) return true;/);
  });

  test('EXCLUDED is reported separately from FAILED', () => {
    // A failed ticker was attempted and could not be read; an excluded one is not
    // charted on this layer at all. Collapsing them makes a scope boundary look
    // like breakage — and a silently shorter list is the bug this whole change fixes.
    const s = src(SUNDAY);
    assert.match(s, /excluded_from_review: excluded/);
    assert.match(s, /excluded: excluded\.length/);
  });

  test('the exclusion filter runs AFTER every queue rebuild', () => {
    /**
     * `--tickers` rebuilds the queue from scratch, so an exclusion applied before it
     * was undone — BTC-USD came back and FAILED instead of being excluded.
     */
    const s = src(SUNDAY);
    assert.ok(s.indexOf('if (ONLY.length)') < s.indexOf('const excluded = []'),
      'the filter must come after the --tickers rebuild, or it is silently undone');
  });

  test('a degraded analysis cannot crash the validation', () => {
    /**
     * `analyzeTicker` returns a shape with no `verdict` when assess() itself fails.
     * Passing that to validateTa crashed on `ours.bias`, turning one failed block
     * into an exception that read like a chart problem.
     */
    assert.match(src(SUNDAY), /if \(!r\.verdict \|\| !r\.assessment\)/);
  });

  test('assess() guards the value area, so one block cannot take the whole thing down', () => {
    /**
     * Every other read in that block used optional chaining; `vp.value_area.high` did
     * not. A profile with no value area — CRYPTO:BTCUSD, whose bars carry volume 0 —
     * threw past all thirty safe() wrappers and killed a 30-block analysis.
     */
    assert.match(src('src/core/assessment.js'), /price_vs_value_area: vp\?\.value_area/);
  });
});
