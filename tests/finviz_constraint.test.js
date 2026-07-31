import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  applyTradability, pythonCandidates, finvizConstraints, beginConstraints,
} from '../src/core/finviz.js';

/**
 * Finviz is a CONSTRAINT, not a screen.
 *
 * The tempting move after reading a swing-trading workflow is to add its screener.
 * Everything in it — sector, relative volume, price above the 20/50/200 — is
 * already in TradingView's scanner, and the trend-alignment clause is `stage_plan`,
 * forward-tested at 33.5% against a 36.4% baseline. What Finviz uniquely has is not
 * a way to FIND a candidate but a reason to REJECT one.
 */
const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');
const cand = (symbol, bias) => ({ symbol, stage2: { bias } });

describe('the veto is direction-aware', () => {
  const constraints = {
    available: true,
    tickers: {
      NOBORROW: { optionable_and_shortable: false, basis: 'liquid enough, genuine gap' },
      FINE: { optionable_and_shortable: true },
      UNTESTED: { optionable_and_shortable: null, basis: 'below the liquidity bar' },
    },
  };

  test('a BEARISH read on a name with no borrow is vetoed', () => {
    const r = applyTradability([cand('NASDAQ:NOBORROW', 'BEARISH')], constraints);
    assert.deepEqual(r.kept, []);
    assert.equal(r.vetoed.length, 1);
    assert.match(r.vetoed[0].why, /no borrow means no trade/);
  });

  test('a BULLISH read on the SAME name is kept', () => {
    // Shortability only binds on something we would short. Vetoing a long for a
    // borrow it never needed would discard a perfectly good candidate.
    const r = applyTradability([cand('NASDAQ:NOBORROW', 'BULLISH')], constraints);
    assert.equal(r.kept.length, 1);
    assert.equal(r.vetoed.length, 0);
    assert.match(r.flagged[0].why, /a SHORT here would not be executable/);
  });

  test('a BEARISH read on a shortable name passes untouched', () => {
    const r = applyTradability([cand('NASDAQ:FINE', 'BEARISH')], constraints);
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
    assert.deepEqual(r.flagged, []);
  });
});

describe('unknown is not a negative', () => {
  test('a null shortability vetoes nothing, even on a bearish read', () => {
    /**
     * `null` means the query failed OR the name sat below the liquidity bar the
     * query used and was never tested. Neither is evidence it cannot be borrowed.
     */
    const r = applyTradability([cand('NASDAQ:UNTESTED', 'BEARISH')], {
      available: true,
      tickers: { UNTESTED: { optionable_and_shortable: null, basis: 'never tested' } },
    });
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
  });

  test('a name Finviz never answered for vetoes nothing', () => {
    const r = applyTradability([cand('NASDAQ:MISSING', 'BEARISH')], { available: true, tickers: {} });
    assert.equal(r.kept.length, 1);
    assert.deepEqual(r.vetoed, []);
  });

  test('Finviz being DOWN vetoes nothing, and says so', () => {
    /**
     * The whole point. This shells out to Python and scrapes a third-party site —
     * it will be down, slow, or newly-broken. Dropping candidates because a scrape
     * failed would be inventing a reason.
     */
    const all = [cand('A', 'BEARISH'), cand('B', 'BEARISH'), cand('C', 'BULLISH')];
    const r = applyTradability(all, { available: false, why: 'timed out', tickers: {} });
    assert.equal(r.kept.length, 3);
    assert.deepEqual(r.vetoed, []);
    assert.match(r.note, /UNAVAILABLE/);
    assert.match(r.note, /not evidence a name is untradeable/);
  });
});

describe('earnings timing is carried, not acted on', () => {
  test('reporting this week is a flag', () => {
    // The existing veto already handles the DATE. What Finviz adds is BMO/AMC, and
    // that is a fact for the plan to weigh, not a second automatic rejection.
    const r = applyTradability([cand('X', 'BULLISH')], {
      available: true,
      tickers: { X: { optionable_and_shortable: true, reports_this_week: true } },
    });
    assert.equal(r.kept.length, 1);
    assert.match(r.flagged[0].why, /reports this week/);
  });
});

describe('which python, and what happens when there is none', () => {
  /**
   * It spawned a bare `python`, which is a NAME, not a program. Absent where the
   * interpreter is `python3`; present-but-useless on Windows, where the Microsoft
   * Store stub sits on PATH, prints an advert and exits non-zero.
   */
  test('FINVIZ_PYTHON wins, and is the ONLY candidate tried', () => {
    const c = pythonCandidates({ env: { FINVIZ_PYTHON: '/venv/bin/python' }, platform: 'linux' });
    assert.equal(c.length, 1, 'an explicit setting must not fall through to another interpreter');
    assert.equal(c[0].command, '/venv/bin/python');
    assert.equal(c[0].source, 'FINVIZ_PYTHON');
  });

  test('FINVIZ_PYTHON is never split on whitespace', () => {
    // The common Windows value. Splitting it looks for a program called `C:\\Program`.
    const c = pythonCandidates({ env: { FINVIZ_PYTHON: 'C:\\Program Files\\Python312\\python.exe' } });
    assert.equal(c[0].command, 'C:\\Program Files\\Python312\\python.exe');
    assert.deepEqual(c[0].args, []);
  });

  test('unset falls back to what works today, python FIRST', () => {
    // Bare `python` runs here. The chain must not change behaviour where it works.
    const c = pythonCandidates({ env: {}, platform: 'linux' });
    assert.equal(c[0].command, 'python');
    assert.ok(c.map((x) => x.command).includes('python3'));
  });

  test('Windows also gets the launcher, which skips the Store stub', () => {
    const c = pythonCandidates({ env: {}, platform: 'win32' });
    const py = c.find((x) => x.command === 'py');
    assert.ok(py, 'the `py` launcher finds a real install when neither name is on PATH');
    assert.deepEqual(py.args, ['-3']);
  });

  test('an explicit argument beats the environment', () => {
    const c = pythonCandidates({ python: 'from-the-caller', env: { FINVIZ_PYTHON: 'from-the-env' } });
    assert.equal(c.length, 1);
    assert.equal(c[0].command, 'from-the-caller');
  });

  test('a BROKEN interpreter degrades to unavailable — never a throw, never a veto', async () => {
    /**
     * The whole rule: a missing interpreter is the same kind of failure as a
     * timeout. It must resolve, not reject, and it must veto nothing — dropping a
     * candidate because a shell lookup missed would be inventing a reason.
     */
    const r = await finvizConstraints(['AAPL'], { python: 'definitely-not-an-interpreter-xyz' });
    assert.equal(r.available, false);
    assert.equal(r.python, null);
    assert.ok(r.why, 'it must say what it tried');
    assert.deepEqual(r.tickers, {});

    const applied = applyTradability([cand('NASDAQ:AAPL', 'BEARISH')], r);
    assert.equal(applied.kept.length, 1);
    assert.deepEqual(applied.vetoed, [], 'no interpreter is not evidence a name is untradeable');
  });

  test('a broken FINVIZ_PYTHON is reported, not silently routed around', async () => {
    /**
     * Falling through to some other interpreter would run the scrape against a
     * different package set than the one that was configured — a wrong answer that
     * looks like a right one. An honest `unavailable` is the better outcome.
     */
    const before = process.env.FINVIZ_PYTHON;
    process.env.FINVIZ_PYTHON = 'definitely-not-an-interpreter-xyz';
    try {
      const r = await finvizConstraints(['AAPL']);
      assert.equal(r.available, false);
      assert.equal(r.attempts.length, 1, 'exactly one attempt — the one that was configured');
      assert.equal(r.attempts[0].source, 'FINVIZ_PYTHON');
      assert.match(r.why, /definitely-not-an-interpreter-xyz/);
    } finally {
      if (before === undefined) delete process.env.FINVIZ_PYTHON; else process.env.FINVIZ_PYTHON = before;
    }
  });

  test('a broken FIRST candidate does not sink the run — the chain advances', async () => {
    /**
     * Walked for real, with real child processes and no network. The second
     * candidate stands in for a working interpreter: it prints the same JSON shape
     * `finviz_screen.py --tickers` prints and exits 0.
     */
    const payload = JSON.stringify({ tickers: { AAA: { optionable_and_shortable: true } } });
    const r = await finvizConstraints(['AAA'], {
      candidates: [
        { command: 'definitely-not-an-interpreter-xyz', args: [], source: 'fallback' },
        { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(payload)})`], source: 'fallback' },
      ],
    });
    assert.equal(r.available, true);
    assert.equal(r.tickers.AAA.optionable_and_shortable, true);
    // The label carries the args too, so `py -3` is distinguishable from `py`.
    assert.ok(r.python.startsWith(process.execPath), 'the result names the interpreter that actually answered');
    assert.equal(r.attempts.length, 1, 'the failed first attempt is recorded, not swallowed');
  });

  test('an interpreter that RAN and failed stops the chain', async () => {
    /**
     * The distinction the chain turns on. A non-zero exit with output means Python
     * executed our script and gave a definite answer; scraping the site twice more
     * to be told the same thing is rude and slow. A silent non-zero exit is the
     * Windows Store stub — it is on PATH, so ENOENT never fires — and that DOES
     * advance.
     */
    const ran = await finvizConstraints(['AAA'], {
      candidates: [
        // writeSync, not console.log: process.exit truncates an async pipe write on
        // Windows, and the stub would then look like it had printed nothing.
        { command: process.execPath, args: ['-e', 'require("fs").writeSync(1,"{}"); process.exit(3)'], source: 'fallback' },
        { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({tickers:{}}))'], source: 'fallback' },
      ],
    });
    assert.equal(ran.available, false);
    assert.equal(ran.attempts.length, 1, 'it ran — do not try the next interpreter');

    const stub = await finvizConstraints(['AAA'], {
      candidates: [
        { command: process.execPath, args: ['-e', 'process.exit(9009)'], source: 'fallback' },
        { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({tickers:{}}))'], source: 'fallback' },
      ],
    });
    assert.equal(stub.available, true, 'a stub that printed nothing never ran us — advance');
  });

  test('an interpreter WITHOUT finvizfinance is not a success — the chain moves on', async () => {
    /**
     * Measured on this box: bare `python` has the package, `python3` does not. The
     * Python's import sits under `except ImportError`, so the packageless one exits
     * 0 with well-formed JSON in which every answer is null — and a naive chain
     * would report "Finviz answered for 20 names" having answered for none.
     *
     * It costs the site nothing to move on: that path makes no request at all.
     */
    const missing = JSON.stringify({
      sizes: { tradable: null, liquid: null, reporting_this_week: null },
      parse: {
        tradable: 'finvizfinance not installed — pip install finvizfinance',
        liquid: 'finvizfinance not installed — pip install finvizfinance',
        earnings: 'finvizfinance not installed — pip install finvizfinance',
      },
      tickers: { AAA: { optionable_and_shortable: null } },
    });
    const good = JSON.stringify({
      sizes: { tradable: 1854, liquid: 2100, reporting_this_week: 90 },
      parse: { tradable: '1854 rows', liquid: '2100 rows', earnings: '90 rows' },
      tickers: { AAA: { optionable_and_shortable: true } },
    });
    const node = (payload) => ({
      command: process.execPath, args: ['-e', `console.log(${JSON.stringify(payload)})`], source: 'fallback',
    });

    const r = await finvizConstraints(['AAA'], { candidates: [node(missing), node(good)] });
    assert.equal(r.available, true);
    assert.equal(r.tickers.AAA.optionable_and_shortable, true, 'the answer must come from the interpreter that HAS the package');
    assert.equal(r.attempts.length, 1);
    assert.match(r.attempts[0].why, /pip install finvizfinance/, 'and it must name the fix');

    // With nowhere left to go it degrades to unavailable, which vetoes nothing.
    const none = await finvizConstraints(['AAA'], { candidates: [node(missing)] });
    assert.equal(none.available, false);
    assert.match(none.why, /pip install finvizfinance/);
    assert.deepEqual(applyTradability([cand('NASDAQ:AAA', 'BEARISH')], none).vetoed, []);
  });

  test('a SITE failure stops the chain — do not scrape a broken site three times', async () => {
    // Python was fine and finviz.com was not. Another interpreter changes nothing
    // and costs the site two more hits, which is the rate discipline the Python
    // states in its own header.
    const siteDown = JSON.stringify({
      sizes: { tradable: null, liquid: null, reporting_this_week: null },
      parse: { tradable: 'screener error: HTTPError 503', liquid: 'screener error: HTTPError 503', earnings: 'screener error: HTTPError 503' },
      tickers: { AAA: { optionable_and_shortable: null } },
    });
    const r = await finvizConstraints(['AAA'], {
      candidates: [
        { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(siteDown)})`], source: 'fallback' },
        { command: 'must-never-be-reached', args: [], source: 'fallback' },
      ],
    });
    assert.deepEqual(r.attempts, [], 'the second candidate must never be tried');
    assert.equal(r.tickers.AAA.optionable_and_shortable, null, 'and null still vetoes nothing');
  });

  test('the timeout is a deadline for the WHOLE call, not per attempt', async () => {
    // A hung scrape must not stall the pre-open run beyond the existing timeout,
    // and walking three candidates must not silently triple it.
    const began = Date.now();
    const r = await finvizConstraints(['AAA'], {
      timeout_ms: 250,
      candidates: [
        { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], source: 'fallback' },
        { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], source: 'fallback' },
      ],
    });
    const took = Date.now() - began;
    assert.equal(r.available, false);
    assert.match(r.why, /timed out/);
    assert.ok(took < 2000, `the whole call must respect the deadline, took ${took}ms`);
  });

  test('an empty ticker list never spawns anything', async () => {
    const r = await finvizConstraints([], { python: 'definitely-not-an-interpreter-xyz' });
    assert.equal(r.available, false);
    assert.match(r.why, /no tickers/);
    assert.deepEqual(r.attempts, []);
  });
});

describe('the scrape is overlapped with the chart work', () => {
  /**
   * `enrich` issues three paginated scrapes SERIALLY inside one Python process,
   * ~90s together. That serialisation is the rate discipline the Python states in
   * its own header and is deliberately left alone — the WHOLE batch is overlapped
   * with the detector gate instead, which hides all of it rather than two thirds.
   *
   * The property under test is the one that matters: the scrape must have STARTED
   * before the chart work finished, so awaiting it afterwards costs almost nothing.
   */
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  test('it starts before the chart work, and the await barely blocks', async () => {
    const order = [];
    const job = beginConstraints(['AAA', 'BBB'], {
      run: async () => { order.push('scrape started'); await tick(40); order.push('scrape done'); return { available: true, tickers: {} }; },
    });

    // Stand-in for the detector gate: longer than the scrape, drives the chart.
    order.push('chart work started');
    await tick(90);
    order.push('chart work done');

    const waitFrom = Date.now();
    const r = await job.promise;
    const waited = Date.now() - waitFrom;

    assert.deepEqual(order, ['scrape started', 'chart work started', 'scrape done', 'chart work done'],
      'the scrape must run INSIDE the chart-work window, not after it');
    assert.ok(waited < 25, `awaiting an already-finished scrape must be free, blocked ${waited}ms`);
    assert.equal(r.available, true);
    assert.ok(r.duration_ms >= 0, 'the handle reports what the scrape actually cost, so the saving is measured');
  });

  test('the handle normalises the ask, so a superset can be passed', () => {
    // The pre-gate set is passed because the survivors do not exist yet, and
    // `enrich` answers by set membership — 150 names cost what 20 cost.
    const job = beginConstraints(['NASDAQ:AAPL', 'BATS:aapl', 'NYSE:BE'], { run: async () => ({ available: true, tickers: {} }) });
    assert.deepEqual(job.requested, ['AAPL', 'BE']);
    return job.promise;
  });

  test('a scrape that REJECTS still leaves a usable, non-vetoing answer', async () => {
    /**
     * Started early means started outside a try/catch that used to wrap it. An
     * unhandled rejection here would take the whole pre-open run down for a
     * third-party site being slow.
     */
    const job = beginConstraints(['AAA'], { run: async () => { throw new Error('scrape blew up'); } });
    const r = await job.promise;
    assert.equal(r.available, false);
    assert.match(r.why, /scrape blew up/);

    const applied = applyTradability([cand('NASDAQ:AAA', 'BEARISH')], r);
    assert.equal(applied.kept.length, 1);
    assert.deepEqual(applied.vetoed, []);
    assert.match(applied.note, /UNAVAILABLE/);
  });

  test('a scrape that throws SYNCHRONOUSLY degrades the same way', async () => {
    const job = beginConstraints(['AAA'], { run: () => { throw new Error('bad argument'); } });
    const r = await job.promise;
    assert.equal(r.available, false);
    assert.match(r.why, /bad argument/);
  });

  test('the child is killed if the run dies, and the guard does not pile up', async () => {
    /**
     * Starting early widened the child's lifetime from one await to several minutes
     * of chart work, so a crash in between would now leave a live Python process
     * scraping. It must be cleaned up — and the listener that does it must not
     * accumulate, or a long-lived caller gets a MaxListeners warning.
     */
    const before = process.listenerCount('exit');
    const job = beginConstraints(['AAA'], { run: async () => ({ available: true, tickers: {} }) });
    assert.equal(process.listenerCount('exit'), before + 1, 'the guard is registered while the child may be alive');
    await job.promise;
    assert.equal(process.listenerCount('exit'), before, 'and removed the moment the scrape settles');
  });

  test('it can be cancelled when nothing survives the gate', async () => {
    // With no candidates there is nothing to constrain, and waiting ~90s for an
    // answer about an empty list is the same waste in a different place.
    const job = beginConstraints(['AAA'], {
      run: async (_t, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ available: false, tickers: {}, why: `cancelled: ${signal.reason}` }));
      }),
    });
    job.cancel('nothing survived the gate');
    const r = await job.promise;
    assert.equal(r.available, false);
    assert.match(r.why, /nothing survived the gate/);
  });
});

describe('it is wired in, and it is not a screen', () => {
  test('the morning routine applies it before the watchlist is written', () => {
    const m = src('scripts/morning-screen.js');
    assert.match(m, /beginConstraints\(preGate\)/);
    assert.match(m, /await tradabilityJob\.promise/);
    assert.match(m, /applyTradability\(allSelected, tradability\)/);
    assert.ok(m.indexOf('applyTradability') < m.indexOf('const built = buildSectioned'),
      'a vetoed name must never reach the watchlist');
  });

  test('the scrape STARTS before the gate and is AWAITED after it', () => {
    /**
     * A source contract, in the same spirit as tests/symbol_stamp.test.js. The
     * ordering is the whole optimisation: start it where the candidates are known,
     * await it where the answer is used, and the ~90s disappears into the minutes
     * the gate spends driving the chart.
     */
    const m = src('scripts/morning-screen.js');
    const started = m.indexOf('beginConstraints(preGate)');
    const gate = m.indexOf('await gateAndSelect(');
    const awaited = m.indexOf('await tradabilityJob.promise');
    assert.ok(started > 0 && gate > 0 && awaited > 0, 'all three sites must exist');
    assert.ok(started < gate, 'the scrape must be started BEFORE the detector gate, or it hides nothing');
    assert.ok(gate < awaited, 'the await must come AFTER the gate, or the start site is decorative');
    assert.ok(m.indexOf('const { tiers, unclassified } = assignTiers(') < awaited,
      'awaited where the answer is consumed — after the tiers exist');
  });

  test('the await is as LATE as the veto-before-write rule allows', () => {
    /**
     * The scrape is MEASURED at 284s, not the ~90s that motivated this, so every
     * second of window matters. The watchlist read, the breadth scan and the
     * 2000-row factor scan are all chart-free and all fit inside it; the only hard
     * stop is that a veto has to remove a name before the list is written.
     */
    const m = src('scripts/morning-screen.js');
    const awaited = m.indexOf('await tradabilityJob.promise');
    assert.ok(m.indexOf('await listContents(WATCHLIST_NAME)') < awaited, 'the watchlist read fits inside the window');
    assert.ok(m.indexOf('columns: FACTOR_COLUMNS') < awaited, 'so does the 2000-row factor scan');
    assert.ok(awaited < m.indexOf('const built = buildSectioned'),
      'but NOT past the watchlist build — a veto must remove a name before it is written');
  });

  test('the chart pipeline gains no dependency on scrape timing', () => {
    // Nothing between the start and the await may read the scrape. If it did, the
    // chart work would be waiting on a third-party site again.
    const m = src('scripts/morning-screen.js');
    const between = m.slice(m.indexOf('beginConstraints(preGate)'), m.indexOf('await tradabilityJob.promise'));
    assert.ok(!/tradabilityJob\.promise/.test(between), 'no early await may sneak in');
    assert.ok(!/\btradability\b\s*\./.test(between), 'the result must not be read before it is awaited');
  });

  test('the report says which interpreter answered, and what the overlap hid', () => {
    /**
     * "No interpreter" and "the site was down" both used to surface as the same
     * shrug. The first is a machine that needs FINVIZ_PYTHON set; the second is
     * nothing anyone can fix. And a saving that is not measured is a saving that
     * is asserted.
     */
    const m = src('scripts/morning-screen.js');
    assert.match(m, /python: tradability\.python/);
    assert.match(m, /interpreter_attempts: tradability\.attempts/);
    assert.match(m, /overlap: tradabilityOverlap/);
    assert.match(m, /hidden_ms:/);
  });

  test('vetoed names are removed from their tier', () => {
    // Reporting a veto without acting on it is the "declared and skipped" pattern.
    assert.match(src('scripts/morning-screen.js'), /tiers\[t\] = tiers\[t\]\.filter\(\(x\) => !dead\.has\(x\.symbol\)\)/);
  });

  test('it is NOT registered as a screen', () => {
    /**
     * A ninth screen would duplicate what TradingView already does faster, from a
     * scraped source, and would need a strategy in the catalogue or its survivors
     * would classify as null and vanish. Finviz finds nothing; it only removes.
     */
    const screens = src('src/core/screens.js');
    assert.ok(!/finviz/i.test(screens), 'Finviz must not appear in SCREENS or INTRADAY_SCREENS');
    assert.match(src('src/core/finviz.js'), /not a screener/i);
  });

  test('the report distinguishes vetoed from flagged, and says when it could not run', () => {
    const m = src('scripts/morning-screen.js');
    assert.match(m, /vetoed: tradabilityResult\.vetoed/);
    assert.match(m, /flagged: tradabilityResult\.flagged/);
    assert.match(m, /why_unavailable: tradability\.why/);
  });
});
