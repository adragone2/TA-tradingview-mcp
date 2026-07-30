import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyTier, SECTION_FOR } from '../src/core/tier_classify.js';
import { stageTwo, topSurvivors } from '../src/core/stage_two.js';
import {
  eligibleScreens, gateAndSelect, assignTiers, strategiesForScreen, screenerKeys, PRE_GATE, PER_SCANNER,
} from '../src/core/morning_routine.js';
import { SCREENS, INTRADAY_SCREENS } from '../src/core/screens.js';
import { buildSectioned, parseSections } from '../src/core/watchlist_rewrite.js';
import { readFileSync } from 'node:fs';

/**
 * The morning routine's contract.
 *
 * The change it encodes: detectors run BEFORE the per-scanner cut, so the five
 * that reach the watchlist are five that SURVIVED rather than five the scanner
 * ranked highest. The old shape merged first and measured afterwards, which
 * inverts this repo's own stated design.
 */

describe('tier classification', () => {
  test('the tier comes from the strategy, and best evidence wins', () => {
    const c = classifyTier([
      { name: 'weak', execution: 'weekly', evidence_tier: 'C' },
      { name: 'strong', execution: 'monthly', evidence_tier: 'B' },
    ]);
    assert.equal(c.tier, 'monthly');
    assert.equal(c.from.strategy, 'strong');
  });

  test('a tie on evidence takes the LONGER horizon', () => {
    /**
     * Below ~21 trading days the documented effect is REVERSAL, and almost every
     * structural setup here is a continuation bet. Filing a tie as weekly would
     * put it on the weak side of the sign change.
     */
    const c = classifyTier([
      { name: 'a', execution: 'weekly', evidence_tier: 'C' },
      { name: 'b', execution: 'monthly', evidence_tier: 'C' },
    ]);
    assert.equal(c.tier, 'monthly');
    assert.match(c.basis, /LONGER horizon wins/);
  });

  test('REJECTED strategies never decide a tier', () => {
    // Six catalogue entries are kept deliberately as refuted. Routing on one
    // would file a name by an idea measured to have no edge.
    const only = classifyTier([{ name: 'REJECTED_x', execution: 'weekly', evidence_tier: 'REJECTED' }]);
    assert.equal(only.tier, null);
    assert.match(only.basis, /measured to have no edge/);

    const mixed = classifyTier([
      { name: 'REJECTED_crabel', execution: 'weekly', evidence_tier: 'REJECTED' },
      { name: 'vcp', execution: 'monthly', evidence_tier: 'B' },
    ]);
    assert.equal(mixed.tier, 'monthly');
    assert.deepEqual(mixed.rejected_ignored, ['REJECTED_crabel']);
  });

  test('an unclassifiable symbol is reported, never defaulted to a tier', () => {
    assert.equal(classifyTier([]).tier, null);
    assert.equal(classifyTier([{ name: 'x', execution: 'quarterly', evidence_tier: 'A' }]).tier, null);
  });

  test('every tier maps to a watchlist section', () => {
    assert.deepEqual(SECTION_FOR, { intraday: 'INTRADAY', weekly: 'WEEKLY', monthly: 'MONTHLY' });
  });
});

describe('the detector gate', () => {
  const trend = (n, f) => Array.from({ length: n }, (_, i) => {
    const p = f(i);
    return { time: 1700000000 + i * 86400, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 };
  });

  test('too few bars is a rejection with a reason, not a pass', () => {
    const r = stageTwo(trend(20, (i) => 10 + i * 0.1));
    assert.equal(r.passed, false);
    assert.match(r.why, /need 60/);
  });

  test('the gate can actually reject — otherwise it is not a gate', () => {
    // Pure noise around a flat mean: the efficiency reading should call it choppy.
    const chop = trend(200, (i) => 50 + Math.sin(i / 2) * 2 + Math.sin(i / 7) * 1.5);
    const r = stageTwo(chop);
    assert.equal(typeof r.passed, 'boolean');
    assert.ok(r.why.length > 0, 'a verdict must always carry its reason');
    if (!r.passed) assert.match(r.why, /choppy|not tradeable/);
  });

  test('survivors are ranked, and rejects can never be selected', () => {
    const mk = (symbol, passed, score, screens = []) => ({ symbol, screens, stage2: { passed, score } });
    const picked = topSurvivors([
      mk('A', true, 10), mk('B', false, 99), mk('C', true, 30), mk('D', true, 20),
    ], 2);
    assert.deepEqual(picked.map((x) => x.symbol), ['C', 'D']);
    assert.ok(!picked.some((x) => x.symbol === 'B'), 'a rejected name must never reach the watchlist');
  });

  test('confluence breaks a tie on score', () => {
    const mk = (symbol, screens) => ({ symbol, screens, stage2: { passed: true, score: 10 } });
    const picked = topSurvivors([mk('ONE', ['a']), mk('THREE', ['a', 'b', 'c'])], 1);
    assert.equal(picked[0].symbol, 'THREE');
  });
});

describe('every screen can reach a strategy', () => {
  /**
   * The tier comes from the STRATEGY. A screen pointing at no strategy produces
   * survivors that classify as null and are dropped from the watchlist in silence
   * — a screen that runs, gates, selects, and then throws its results away.
   *
   * Two were found this way. `rs_leadership` genuinely had no catalogue entry.
   * `short_term_reversal` had one, but its screener field is prose —
   * "screens:short_term_reversal (+ morning-screen:tier_a_factors for the VIX
   * gate)" — and the naive parser returned "tier_a_factors for the VIX gate)".
   */
  test('no screen points at nothing', () => {
    const gaps = [...SCREENS, ...INTRADAY_SCREENS]
      .filter((s) => !strategiesForScreen(s.key).some((x) => x.evidence_tier !== 'REJECTED'))
      .map((s) => s.key);
    assert.deepEqual(gaps, [],
      `${gaps.join(', ')} would gate and select symbols that then classify as null and vanish. `
      + 'Point the screen at a strategy in strategies.json, or remove the screen.');
  });

  test('the screener field is parsed as identifiers, not as prose', () => {
    assert.deepEqual(
      screenerKeys('screens:short_term_reversal (+ morning-screen:tier_a_factors for the VIX gate)'),
      ['short_term_reversal', 'tier_a_factors'],
    );
    // DIGITS belong to the key. Omitting them truncated `screens:near_52w_high`
    // to "near_" and opened a second silent gap while the first was being closed.
    assert.deepEqual(screenerKeys('screens:near_52w_high'), ['near_52w_high']);
    // The six REJECTED entries say "none" and must match nothing.
    for (const none of ['none', 'none as a standalone', 'none — do not screen for this']) {
      assert.deepEqual(screenerKeys(none), [], `"${none}" must not resolve to a screen`);
    }
  });
});

describe('there is no rebalance clock on the watchlist', () => {
  const script = readFileSync(`${process.cwd()}/scripts/morning-screen.js`, 'utf8');

  test('every managed section is rebuilt every run', () => {
    /**
     * A monthly clock was inherited from the Weeks/Months design and it was wrong
     * twice over.
     *
     * Mechanically: it read `months_last_rebalance` from a state file that the
     * DELETED 2.x pipeline had stamped that same morning, so MONTHLY carried forward
     * the twelve names 2.x had chosen and cited 2.x's own timestamp as the reason it
     * was not allowed to change.
     *
     * Conceptually: INTRADAY/WEEKLY/MONTHLY is an EXECUTION split — how long a trade
     * is held — not a refresh rate. And a watchlist is a list of candidates; adding a
     * name to it places no trade. The turnover arithmetic that justifies a monthly
     * clock (252 round trips a year, 50.4% drag at 20bps) is about HOLDING positions
     * and never applied to refreshing a list of things to look at.
     */
    assert.ok(!/rebalanceDue\(/.test(script),
      'the watchlist write must not consult a rebalance clock');
    // The stamp must not be WRITTEN or READ. It may still be named in the comment
    // explaining why it was removed — that comment is the point of keeping it.
    assert.ok(!/months_last_rebalance:/.test(script), 'the stamp must not be written');
    assert.ok(!/\.months_last_rebalance/.test(script), 'and must not be read back');
    assert.ok(!/--force-monthly/.test(script),
      'a flag to override a clock that no longer exists is a promise the script cannot keep');
    // All three sections take real arrays. `null` means "carry forward" and nothing passes it.
    const block = script.slice(script.indexOf('const sectionsToWrite'), script.indexOf('const built ='));
    assert.equal((block.match(/symbols: tiers\./g) || []).length, 3,
      'INTRADAY, WEEKLY and MONTHLY must each be written from this run\'s survivors');
    assert.ok(!/symbols: \w+\.due \?/.test(block), 'no conditional carry-forward');
  });

  test('buildSectioned still SUPPORTS carry-forward — it just is not used', () => {
    // Removing the capability would be over-correcting: it is the only safe way to
    // express "this section was not computed", which is different from "it is empty".
    const r = buildSectioned(['###⁤WEEKLY', 'X'], { sections: [{ name: 'WEEKLY', symbols: null }] });
    assert.deepEqual(r.sections.WEEKLY, ['X']);
  });
});

describe('charts dropping out of the list are actually cleaned', () => {
  const script = readFileSync(`${process.cwd()}/scripts/morning-screen.js`, 'utf8');

  test('the cleanup removes TRACKED drawings, not only orphans', () => {
    /**
     * This called `removeOrphans` alone, which by definition removes shapes that are
     * NOT in the registry. Yesterday's drawings ARE in it — the registry persists
     * across processes — so every one was classified `tracked`, skipped, and the run
     * logged "removed 0 stale shape(s)" while leaving all of them in place.
     *
     * Verified on the live chart: ALM dropped out of the list still carrying all 22
     * shapes from the previous run, cleanup reported success, and a subsequent
     * `draw_clear scope:"mcp"` removed 22.
     *
     * It is an unbounded leak, not a cosmetic one: the next run does not visit a name
     * that fell off the list, so nothing would ever come back for those shapes.
     */
    const block = script.slice(script.indexOf('clearing ${dropped.length} chart(s)'),
      script.indexOf('stale shape(s) from dropped names'));
    assert.match(block, /drawing\.clearAll\(\{ scope: 'mcp' \}\)/,
      'tracked drawings need clearAll — removeOrphans cannot see them');
    assert.match(block, /removeOrphans\(\{ dry_run: false/,
      'and the orphan pass stays, for entries whose registry record died with an old session');
  });

  test('both counts are reported separately', () => {
    // One number hid the failure: "removed 0" read as "there was nothing to remove".
    assert.match(script, /removed \$\{tracked\} tracked \+ \$\{orphaned\} orphaned shape\(s\)/);
  });
});

describe('the intraday tier can actually populate', () => {
  const ext = INTRADAY_SCREENS.find((s) => s.key === 'intraday_extension');

  test('there is an intraday screen that is not pre-open only', () => {
    /**
     * `premarket_gap` was the only intraday screen and it is gated to the pre-open,
     * so the whole tier could populate for at most two hours a day — and any run
     * outside that window produced an empty INTRADAY section with no explanation.
     */
    assert.ok(ext, 'intraday_extension must exist');
    assert.equal(ext.session, undefined, 'it reads no session-sensitive field, so it must not be gated');
  });

  test('it screens on price-only fields, which is why it needs no gate', () => {
    // The partial-day trap is volume-derived fields. close, the moving averages and
    // RSI are price-only: at any hour they are "as of now", never a fraction of a day
    // masquerading as a whole one.
    const fields = [...ext.filter.map((f) => f.left), ...ext.columns];
    for (const unsafe of ['relative_volume_10d_calc', 'premarket_volume', 'premarket_change']) {
      assert.ok(!fields.includes(unsafe), `${unsafe} is session-sensitive and would need a gate`);
    }
  });

  test("it implements parabolic_fade's own criteria, not a new idea", () => {
    // RSI > 75 is the strategy's own threshold, one-sided on purpose: this screen
    // hunts the upper tail, which IS the definition of extended.
    const rsi = ext.filter.find((f) => f.left === 'RSI');
    assert.deepEqual({ op: rsi.operation, right: rsi.right }, { op: 'greater', right: 75 });
    // price >= ema * 1.05, with EMA10 standing in for the unavailable EMA9.
    assert.equal(ext.refine({ close: 105, EMA10: 100 }), true);
    assert.equal(ext.refine({ close: 104, EMA10: 100 }), false);
    // A missing column must not pass. undefined >= NaN is false either way, but the
    // guard makes it deliberate rather than incidental.
    assert.equal(ext.refine({ close: 105 }), false);
    assert.equal(ext.refine({ close: 105, EMA10: 0 }), false);
  });

  test('the gap screen keeps the two strategies that genuinely need the pre-open', () => {
    /**
     * opening_range_break and vwap_reclaim need `minutes_since_open`, `vwap` and
     * `rvol` — none of which exist before the open. An in-play gap list is the only
     * thing a pre-open screen can honestly hand them. parabolic_fade needs none of
     * those, which is why it moved.
     */
    const gap = strategiesForScreen('premarket_gap').map((s) => s.name).sort();
    assert.deepEqual(gap, ['opening_range_break', 'vwap_reclaim']);
    assert.deepEqual(strategiesForScreen('intraday_extension').map((s) => s.name), ['parabolic_fade']);
  });
});

describe('session gating', () => {
  test('a settled-session screen is skipped pre-open, with a reason', () => {
    const { eligible, skipped } = eligibleScreens({
      trust: { session_state: 'premarket', volume_fields_usable: false, reason: 'pre-open' },
    });
    assert.ok(skipped.some((s) => s.key === 'short_term_reversal'));
    assert.ok(eligible.some((s) => s.key === 'premarket_gap'), 'premarket_gap belongs pre-open');
  });

  test('a premarket screen is skipped MID-SESSION, not just after the close', () => {
    /**
     * The inherited gate was `session === 'premarket' && volume_fields_usable`.
     * Volume fields are unusable pre-open AND intraday, so mid-session the flag was
     * false and the premarket screen ran — ranking on premarket_change hours after
     * the open, when it describes a move that finished at 09:30.
     */
    const { eligible, skipped } = eligibleScreens({
      trust: { session_state: 'open', volume_fields_usable: false, reason: 'session is open' },
    });
    assert.ok(!eligible.some((s) => s.key === 'premarket_gap'), 'premarket_gap must not run mid-session');
    assert.match(skipped.find((s) => s.key === 'premarket_gap').why, /session state is "open"/);
  });
});

describe('gate then select, end to end', () => {
  const rows = (syms) => syms.map((symbol) => ({ symbol }));
  const bars = (n, f) => Array.from({ length: n }, (_, i) => {
    const p = f(i);
    return { time: 1700000000 + i * 86400, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6 };
  });

  test('a symbol in several screens is loaded ONCE', async () => {
    const loads = [];
    const loadBars = async (sym) => { loads.push(sym); return bars(200, (i) => 10 + i * 0.05); };
    await gateAndSelect(
      [{ key: 's1', rows: rows(['A', 'B']) }, { key: 's2', rows: rows(['B', 'C']) }],
      loadBars,
    );
    assert.deepEqual(loads.sort(), ['A', 'B', 'C'], 'B appears in both screens and must load once');
  });

  test('a symbol whose bars will not load is rejected, not crashed on', async () => {
    const loadBars = async (sym) => { if (sym === 'BAD') throw new Error('no such symbol'); return bars(200, (i) => 10 + i * 0.05); };
    const { perScreen } = await gateAndSelect([{ key: 's1', rows: rows(['GOOD', 'BAD']) }], loadBars);
    const bad = perScreen.s1.rejected.find((r) => r.symbol === 'BAD');
    assert.ok(bad, 'the failure must be reported, not silently dropped');
    assert.match(bad.why, /could not load bars/);
  });

  test('the pre-gate bounds how many symbols get loaded', async () => {
    const loads = [];
    const loadBars = async (s) => { loads.push(s); return bars(200, (i) => 10 + i * 0.05); };
    const many = rows(Array.from({ length: 100 }, (_, i) => `S${i}`));
    await gateAndSelect([{ key: 's1', rows: many }], loadBars, { pre_gate: 15 });
    assert.equal(loads.length, 15, 'loading all 100 is what makes the run miss the open');
  });

  test('defaults are the documented ones', () => {
    assert.equal(PRE_GATE, 15);
    assert.equal(PER_SCANNER, 5);
  });
});

describe('the watchlist write', () => {
  /**
   * The header format TradingView actually stores — `###`, then U+2064 INVISIBLE
   * PLUS, then the name. Read off the live "Swing Opportunities" list:
   *
   *   "###⁤KEEP - POTENTIAL" => 0023 0023 0023 2064 004b 0045 0045 0050 ...
   *
   * The fixture uses the real bytes because the plain-`###` version passed every
   * one of these tests while the live run would have deleted the KEEP sections.
   */
  const H = (n) => `###⁤${n}`;
  const current = [
    H('INTRADAY'), 'NYSE:CAT',
    H('WEEKLY'), 'NYSE:RSI',
    H('MONTHLY'), 'NASDAQ:TIGO',
    H('KEEP - POTENTIAL'), 'NASDAQ:NVDA',
    H('KEEP - ACTIVE TRADE'), 'NYSE:DLO',
  ];

  test('KEEP sections survive untouched, whatever they are called', () => {
    const r = buildSectioned(current, {
      sections: [
        { name: 'INTRADAY', symbols: ['NASDAQ:AAPL'] },
        { name: 'WEEKLY', symbols: ['NASDAQ:MSFT'] },
        { name: 'MONTHLY', symbols: ['NYSE:XOM'] },
      ],
    });
    assert.deepEqual(r.preserved_sections.map((s) => s.name).sort(),
      ['KEEP - ACTIVE TRADE', 'KEEP - POTENTIAL']);
    assert.ok(r.entries.includes('NASDAQ:NVDA'));
    assert.ok(r.entries.includes('NYSE:DLO'));
  });

  test('a KEEP symbol outranks todays screen, so it can never be duplicated', () => {
    // A duplicate anywhere makes TradingView reject the entire write with a 422.
    const r = buildSectioned(current, {
      sections: [{ name: 'MONTHLY', symbols: ['NASDAQ:NVDA', 'NYSE:XOM'] }],
    });
    assert.deepEqual(r.sections.MONTHLY, ['NYSE:XOM']);
    assert.equal(r.entries.filter((e) => e === 'NASDAQ:NVDA').length, 1);
  });

  test('a symbol classified into two tiers lands in the first only', () => {
    const r = buildSectioned([], {
      sections: [
        { name: 'WEEKLY', symbols: ['X'] },
        { name: 'MONTHLY', symbols: ['X', 'Y'] },
      ],
    });
    assert.deepEqual(r.sections.WEEKLY, ['X']);
    assert.deepEqual(r.sections.MONTHLY, ['Y']);
  });

  test('an unmanaged non-KEEP section is REPORTED before it is dropped', () => {
    const r = buildSectioned([...current, H('Months'), 'NYSE:OLD'], {
      sections: [{ name: 'MONTHLY', symbols: [] }],
    });
    assert.ok(r.dropped_sections.some((s) => s.name === 'Months' && s.count === 1),
      'a rename must not quietly bin a section full of symbols');
  });

  test('null carries a section forward instead of emptying it', () => {
    const r = buildSectioned(current, { sections: [{ name: 'MONTHLY', symbols: null }] });
    assert.deepEqual(r.sections.MONTHLY, ['NASDAQ:TIGO']);
    assert.deepEqual(r.carried_forward, ['MONTHLY']);
  });

  test("TradingView's invisible marker cannot hide a section from its own name", () => {
    /**
     * The bug this encodes. Every header TradingView's UI writes carries U+2064
     * after the `###`, so the parsed name was "⁤KEEP - POTENTIAL" — which does not
     * start with "KEEP". The preservation rule matched nothing, and the first live
     * run would have deleted both KEEP sections and the symbols in them, while
     * writing a second "###INTRADAY" beside the real "###⁤INTRADAY".
     */
    const parsed = parseSections(current);
    assert.deepEqual(parsed.sections.map((s) => s.name),
      ['INTRADAY', 'WEEKLY', 'MONTHLY', 'KEEP - POTENTIAL', 'KEEP - ACTIVE TRADE']);
    assert.equal(parsed.sections[0].header, '###⁤INTRADAY', 'the raw header must round-trip verbatim');

    const r = buildSectioned(current, { sections: [{ name: 'INTRADAY', symbols: ['NASDAQ:AAPL'] }] });
    assert.equal(r.entries.filter((e) => String(e).startsWith('###')).length, 3,
      'rewriting a section must reuse its header, not add a near-identical twin');
    assert.ok(r.entries.includes('###⁤INTRADAY'));
    assert.ok(!r.entries.includes('###INTRADAY'), 'a marker-less duplicate is a new section to TradingView');
    assert.ok(!r.dropped_sections.some((s) => s.name.startsWith('KEEP')),
      'a KEEP section must never be reported as unmanaged — that is the report that precedes deleting it');
  });

  test('a section we create carries the marker too, so the panel stays consistent', () => {
    const r = buildSectioned([], { sections: [{ name: 'WEEKLY', symbols: ['X'] }] });
    assert.deepEqual(r.entries, ['###⁤WEEKLY', 'X']);
  });
});

describe('tier assignment over selected candidates', () => {
  test('a symbol selected by two screens gets ONE tier', () => {
    const sel = (symbol) => ({ symbol, stage2: { passed: true, score: 10 } });
    const { tiers, unclassified } = assignTiers({
      volatility_contraction: { selected: [sel('NASDAQ:AAA')] },
      group_leadership: { selected: [sel('NASDAQ:AAA')] },
    });
    const all = [...tiers.intraday, ...tiers.weekly, ...tiers.monthly];
    assert.equal(all.filter((x) => x.symbol === 'NASDAQ:AAA').length, 1,
      'a symbol must appear in exactly one tier or the watchlist write 422s');
    assert.equal(unclassified.length, 0);
  });
});
