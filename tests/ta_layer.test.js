import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseCsv, freshnessWarnings } from '../src/core/ta_decisions.js';
import { parseTvJsonCsv, bareTicker, buildWallsJson, loadWalls } from '../src/core/ta_walls.js';

/**
 * The TA layer had 907 lines of pure parsing and level-building with no tests
 * — and it is the layer that decides what gets drawn on a chart and what TA is
 * validated against. Everything here is a decoder: when a decoder is wrong it
 * does not throw, it returns plausible data shifted by one column.
 */

describe('parseCsv — TA exports are not naive CSV', () => {
  test('parses a plain table into objects keyed by header', () => {
    const rows = parseCsv('ticker,action,price\nAAPL,BUY,100\nMSFT,SELL,200\n');
    assert.deepEqual(rows, [
      { ticker: 'AAPL', action: 'BUY', price: '100' },
      { ticker: 'MSFT', action: 'SELL', price: '200' },
    ]);
  });

  test('a QUOTED FIELD CONTAINING COMMAS does not shift every later column', () => {
    // TA's catalyst lists look like "PEAD_DRIFT, FROG_IN_PAN". A naive split
    // puts FROG_IN_PAN into `price` and shifts the rest — and the result still
    // looks like a row, which is why this is the most dangerous case here.
    const rows = parseCsv('ticker,catalysts,price\nAAPL,"PEAD_DRIFT, FROG_IN_PAN",100\n');
    assert.equal(rows[0].catalysts, 'PEAD_DRIFT, FROG_IN_PAN');
    assert.equal(rows[0].price, '100');
  });

  test('doubled quotes inside a quoted field become one quote', () => {
    const rows = parseCsv('ticker,note\nAAPL,"he said ""buy"" today"\n');
    assert.equal(rows[0].note, 'he said "buy" today');
  });

  test('CRLF line endings do not leave a stray carriage return', () => {
    // A trailing \r turns "100" into "100\r", and Number("100\r") is 100 but
    // a string comparison against "100" fails — a silent, selective break.
    const rows = parseCsv('ticker,price\r\nAAPL,100\r\n');
    assert.equal(rows[0].price, '100');
    assert.equal(rows[0].ticker, 'AAPL');
  });

  test('header whitespace is trimmed so keys are usable', () => {
    const rows = parseCsv('ticker , action\nAAPL,BUY\n');
    assert.equal(rows[0].ticker, 'AAPL');
    assert.equal(rows[0].action, 'BUY');
  });

  test('a missing trailing field reads as empty, not undefined', () => {
    const rows = parseCsv('a,b,c\n1,2\n');
    assert.equal(rows[0].c, '');
  });

  test('blank lines are skipped rather than becoming empty rows', () => {
    assert.equal(parseCsv('a,b\n1,2\n\n3,4\n').length, 2);
  });

  test('a header-only file yields no rows rather than throwing', () => {
    assert.deepEqual(parseCsv('a,b,c\n'), []);
  });

  test('a quoted field containing a newline stays one field', () => {
    const rows = parseCsv('a,b\n"line1\nline2",x\n');
    assert.equal(rows[0].a, 'line1\nline2');
    assert.equal(rows[0].b, 'x');
  });
});

describe('freshnessWarnings — a 200 is not freshness', () => {
  /**
   * TA stamps age from the source file's mtime. A successful fetch says
   * nothing about whether the upstream scan ran.
   */
  test('warns past 30 hours, and says why that threshold', () => {
    const w = freshnessWarnings({ age_hours: 40 }, 'walls');
    assert.equal(w.length, 1);
    assert.match(w[0], /40h old/);
    assert.match(w[0], /did not happen|stale/);
  });

  test('does not warn inside the window', () => {
    assert.deepEqual(freshnessWarnings({ age_hours: 12 }, 'walls'), []);
  });

  test('UNKNOWN age warns — it is not treated as fresh', () => {
    // The dangerous default. A missing header must never read as current.
    for (const ds of [{}, { age_hours: null }, { age_hours: 'x' }, { age_hours: NaN }]) {
      const w = freshnessWarnings(ds, 'walls');
      assert.equal(w.length, 1, `age ${JSON.stringify(ds)} produced no warning`);
      assert.match(w[0], /unknown/i);
    }
  });

  test('the label is used, so a reader knows WHICH dataset is stale', () => {
    assert.match(freshnessWarnings({ age_hours: 99 }, 'entry decisions')[0], /entry decisions/);
  });

  test('exactly 30 hours does not warn; just past it does', () => {
    assert.deepEqual(freshnessWarnings({ age_hours: 30 }, 'x'), []);
    assert.equal(freshnessWarnings({ age_hours: 30.1 }, 'x').length, 1);
  });
});

describe('parseTvJsonCsv — one bad row must not lose the others', () => {
  const row = (t, obj) => `${t},"${JSON.stringify(obj).replace(/"/g, '""')}"`;

  test('parses quote-wrapped JSON with doubled inner quotes', () => {
    const csv = `ticker,payload\n${row('SMH', { d: { cw: 250 } })}\n`;
    const { byTicker, bad } = parseTvJsonCsv(csv);
    assert.deepEqual(bad, []);
    assert.deepEqual(byTicker.get('SMH').ready, { d: { cw: 250 } });
  });

  test('a malformed row is COLLECTED, not thrown — the rest survive', () => {
    const csv = `ticker,payload\n${row('SMH', { d: 1 })}\nBROKEN,{not json\n${row('XLK', { d: 2 })}\n`;
    const { byTicker, bad } = parseTvJsonCsv(csv);
    assert.equal(byTicker.size, 2, 'a single bad ticker lost the good ones');
    assert.ok(bad.includes('BROKEN'));
  });

  test('tickers are upper-cased so lookups match bareTicker', () => {
    const { byTicker } = parseTvJsonCsv(`h\nsmh,"{""d"":1}"\n`);
    assert.ok(byTicker.has('SMH'));
  });

  test('rows with no comma, and blank lines, are skipped', () => {
    const { byTicker, bad } = parseTvJsonCsv('h\n\nJUSTATICKER\n');
    assert.equal(byTicker.size, 0);
    assert.deepEqual(bad, []);
  });

  test('the header row is never treated as data', () => {
    const { byTicker } = parseTvJsonCsv(`ticker,payload\n${row('SMH', { d: 1 })}\n`);
    assert.ok(!byTicker.has('TICKER'));
    assert.equal(byTicker.size, 1);
  });
});

describe('loadWalls — the manifest has to survive JSON.stringify', () => {
  /**
   * Three rows copied verbatim from the live /api/walls: header `Ticker,TV_JSON`,
   * then ticker + UNQUOTED JSON full of commas. Every other fixture in this file
   * quote-wraps the JSON and doubles its inner quotes — a form the parser
   * tolerates but the served file never uses — so the shape TA actually sends
   * had no test at all, which is how the defect below survived a green suite.
   *
   * The defect: `byTicker` is a Map, and `JSON.stringify(new Map())` is `{}`.
   * Silently. Every walls block written to reports/sunday-review-2026-07-30.json
   * read `rows: 40`, a 40-ticker coverage list, and `byTicker: {}` — the count
   * and the list survived because the same parse had already materialised them
   * into a number and an array, and the walls themselves did not.
   */
  const REAL_CSV = [
    'Ticker,TV_JSON',
    'AMD,{"dCW":500,"dPW":400,"dCGX":450,"dPGX":430,"dS":4,"wCW":495,"wPW":400,"wCGX":300,"wPGX":290,"wS":2,"mCW":500,"mPW":140,"mCGX":210,"mPGX":150,"mS":4,"flip":295,"im":18.29,"vix":17.52,"vvix":96.34,"ts":1785439844}',
    'AMZN,{"dCW":265,"dPW":200,"dCGX":237,"dPGX":225,"dS":4,"wCW":265,"wPW":215,"wCGX":200,"wPGX":170,"wS":2,"mCW":260,"mPW":140,"mCGX":175,"mPGX":155,"mS":4,"flip":192,"im":16.56,"vix":17.52,"vvix":96.34,"ts":1785439844}',
    'SMH,{"dCW":580,"dPW":500,"dCGX":550,"dPGX":520,"dS":4,"wCW":580,"wPW":527,"wCGX":730,"wPGX":435,"wS":2,"mCW":600,"mPW":475,"mCGX":600,"mPGX":475,"mS":4,"flip":573,"im":5.52,"vix":17.52,"vvix":96.34,"ts":1785439844}',
  ].join('\n');

  const FRESHNESS = { generated_at: '2026-07-30T19:30:56.871364+00:00', age_hours: 20.55 };
  const served = (text = REAL_CSV) => async () => ({ text, freshness: FRESHNESS });
  const load = (opts = {}) => loadWalls({ get: served(), ...opts });
  // What ticker_analyze's `walls` section actually writes to the report.
  const wire = async (opts) => JSON.parse(JSON.stringify(await load(opts)));

  test('byTicker reaches the JSON — a Map alone stringifies to {}', async () => {
    const w = await wire();
    assert.equal(Object.keys(w.byTicker).length, 3, 'byTicker serialised empty');
    assert.equal(w.byTicker.AMD.ready.dCW, 500, "AMD's daily call wall did not land");
    assert.equal(w.byTicker.SMH.ready.flip, 573);
  });

  test('the count and the map come from ONE parse, so they cannot disagree', async () => {
    // The regression pin. `rows: 40` beside `byTicker: {}` was representable
    // because the two were computed at different moments from different things.
    for (const opts of [{}, { symbol: 'AMD' }, { symbol: 'NOPE' }]) {
      const w = await wire(opts);
      const size = Object.keys(w.byTicker).length;
      assert.equal(w.rows, size, `rows ${w.rows} != byTicker ${size} for ${JSON.stringify(opts)}`);
      assert.equal(w.tickers.length, size, `tickers != byTicker for ${JSON.stringify(opts)}`);
    }
  });

  test('the in-memory Map and the serialised object agree, entry for entry', async () => {
    const live = await load();
    const w = JSON.parse(JSON.stringify(live));
    assert.equal(live.byTicker.size, Object.keys(w.byTicker).length);
    for (const [t, entry] of live.byTicker) assert.deepEqual(w.byTicker[t], entry);
  });

  test('the requested symbol is honoured — it used to be ignored entirely', async () => {
    // loadWalls({ symbol }) had no `symbol` in its signature, so ticker_analyze
    // asked per ticker and got the whole coverage manifest and nothing else.
    const w = await wire({ symbol: 'AMD' });
    assert.equal(w.requested, 'AMD');
    assert.equal(w.covered, true);
    assert.equal(w.walls.ready.flip, 295, "the requested symbol's walls are missing");
    assert.equal(w.byTicker.AMD.ready.dPW, 400);
  });

  test('the exchange prefix is stripped, so a chart symbol resolves', async () => {
    const w = await wire({ symbol: 'BATS:amd' });
    assert.equal(w.requested, 'AMD');
    assert.equal(w.covered, true);
  });

  test('a covered-but-unrequested symbol is out of byTicker and in coverage', async () => {
    const w = await wire({ symbol: 'AMD' });
    assert.ok(!('AMZN' in w.byTicker), 'the narrowed view leaked other tickers into the answer');
    assert.deepEqual(w.coverage.tickers, ['AMD', 'AMZN', 'SMH']);
    assert.equal(w.coverage.ticker_count, 3);
  });

  test('an uncovered symbol is a definite NEGATIVE, not a broken section', async () => {
    const w = await wire({ symbol: 'ZZZZ' });
    assert.equal(w.covered, false);
    assert.equal(w.walls, null);
    assert.equal(w.rows, 0);
    assert.equal(w.coverage.ticker_count, 3, 'coverage must survive a miss — it is the reason');
  });

  test('freshness and source travel with the manifest', async () => {
    const w = await wire({ symbol: 'AMD' });
    assert.equal(w.age_hours, 20.55);
    assert.equal(w.source, 'walls_json');
    assert.equal(w.format, 'tv_json');
  });

  test('a narrowed view still builds its own symbol, and names the FULL coverage on a miss', async () => {
    const view = await load({ symbol: 'AMD' });
    const built = await buildWallsJson({ symbol: 'AMD', walls: view, vol: { vix: 1, vvix: 1, source: 'ta' } });
    assert.equal(built.payload.flip, 295);
    await assert.rejects(
      () => buildWallsJson({ symbol: 'AMZN', walls: view, vol: { vix: 1, vvix: 1, source: 'ta' } }),
      // Not "coverage is 1 tickers" — the narrowing is the answer's scope, not TA's.
      (e) => /coverage is 3 tickers/.test(e.message),
    );
  });

  test('an injected fetch never enters the shared cache, in either direction', async () => {
    // A fixture served to a live caller would be far worse than the bug above.
    const one = await loadWalls({ get: served(REAL_CSV) });
    const two = await loadWalls({ get: served('Ticker,TV_JSON\nXLK,{"dCW":1,"dS":4}') });
    assert.deepEqual(one.tickers, ['AMD', 'AMZN', 'SMH']);
    assert.deepEqual(two.tickers, ['XLK'], 'the first fixture was cached and served to the second');
  });
});

describe('bareTicker — the join key between TA and TradingView', () => {
  /**
   * TA speaks "SMH", TradingView "BATS:SMH". Every lookup between the layers
   * goes through this, so a miss here reads as "no data for that symbol".
   */
  test('strips the exchange prefix', () => {
    assert.equal(bareTicker('BATS:SMH'), 'SMH');
    assert.equal(bareTicker('NASDAQ:AAPL'), 'AAPL');
  });

  test('upper-cases and trims', () => {
    assert.equal(bareTicker(' nasdaq:aapl '), 'AAPL');
  });

  test('a bare ticker passes through unchanged', () => {
    assert.equal(bareTicker('SMH'), 'SMH');
  });

  test('degenerate input yields an empty string, not a crash', () => {
    for (const v of [null, undefined, '', 123]) assert.equal(typeof bareTicker(v), 'string');
  });

  test('only the LAST colon segment survives a multi-part symbol', () => {
    assert.equal(bareTicker('OTC_DLY:ATEYY'), 'ATEYY');
  });
});

describe('buildWallsJson — the levels the walls overlay actually draws', () => {
  /**
   * Fully injectable: pass `walls` and `vol` and it never touches the network.
   * This is the code whose output ends up as horizontal lines on a live chart,
   * so a wrong strength or a missing horizon is drawn as fact.
   */
  const horizon = (o = {}) => ({
    CW: 250, PW: 200, CGX: 260, PGX: 190,
    call_oi: 5000, put_oi: 5000, status: 'OK', FLIP: 225, IM: 8, spot: 230, ...o,
  });
  const walls = (horizons, extra = {}) => ({
    asOf: '2026-07-28', age_hours: 5, source: 'walls_history', tickers: ['SMH', 'XLK'],
    byTicker: new Map([['SMH', { date: '2026-07-28', horizons }]]), ...extra,
  });
  const vol = { vix: 14, vvix: 90, source: 'ta' };
  const build = (h, extra, v = vol) => buildWallsJson({ symbol: 'BATS:SMH', walls: walls(h, extra), vol: v });

  test('builds a payload per horizon with TA\'s own key names', async () => {
    const r = await build({ Daily: horizon(), Weekly: horizon({ CW: 255 }) });
    assert.equal(r.payload.dCW, 250);
    assert.equal(r.payload.wCW, 255);
    assert.deepEqual(r.horizons_present, ['Daily', 'Weekly']);
  });

  test('strength is 4 only past the open-interest threshold, else 2', async () => {
    // 10,000 contracts is the line. A wall drawn at strength 4 reads as
    // conviction, so the boundary matters.
    const thin = await build({ Daily: horizon({ call_oi: 9999, put_oi: 9999 }) });
    assert.equal(thin.payload.dS, 2);
    const thick = await build({ Daily: horizon({ call_oi: 10000, put_oi: 0 }) });
    assert.equal(thick.payload.dS, 4);
  });

  test('a MISSING horizon zeroes its keys and says so — it is not omitted', async () => {
    // Omitting them would let the indicator read stale values from a previous
    // symbol. Zero plus a warning is the honest encoding.
    const r = await build({ Daily: horizon() });
    assert.equal(r.payload.wCW, 0);
    assert.equal(r.payload.wS, 0);
    assert.ok(r.warnings.some((w) => /No Weekly horizon/.test(w)));
    assert.deepEqual(r.horizons_present, ['Daily']);
  });

  test('the primary horizon is Weekly when present, else Daily', async () => {
    const both = await build({ Daily: horizon({ FLIP: 111 }), Weekly: horizon({ FLIP: 222 }) });
    assert.equal(both.payload.flip, 222, 'Weekly should win');
    const dailyOnly = await build({ Daily: horizon({ FLIP: 111 }) });
    assert.equal(dailyOnly.payload.flip, 111);
  });

  test('a thin option chain is surfaced, not silently accepted', async () => {
    const r = await build({ Daily: horizon({ status: 'THIN' }) });
    assert.ok(r.warnings.some((w) => /THIN/.test(w) && /less reliable/.test(w)));
  });

  test('stale walls warn past 30 hours', async () => {
    const r = await build({ Daily: horizon() }, { age_hours: 40 });
    assert.ok(r.warnings.some((w) => /40h old/.test(w)));
  });

  test('a snapshot older than three days warns with its date', async () => {
    const old = { date: '2020-01-02', horizons: { Daily: horizon() } };
    const r = await buildWallsJson({
      symbol: 'SMH', vol,
      walls: { asOf: '2020-01-02', age_hours: 5, source: 's', tickers: ['SMH'], byTicker: new Map([['SMH', old]]) },
    });
    assert.ok(r.warnings.some((w) => /days old \(2020-01-02\)/.test(w)));
  });

  test('VIX that did not come from TA is zeroed AND flagged', async () => {
    const r = await build({ Daily: horizon() }, {}, { vix: 0, vvix: 0, source: 'fallback' });
    assert.ok(r.warnings.some((w) => /VIX\/VVIX could not be read/.test(w)));
  });

  test('a ready payload from /api/walls is passed through VERBATIM', async () => {
    // Rebuilding it would risk drifting from what walls_scanner emits.
    const ready = { dCW: 1, dS: 4, wS: 0, mS: 0, flip: 9, custom_field: 'kept' };
    const r = await buildWallsJson({
      symbol: 'SMH', vol,
      walls: { asOf: 'x', age_hours: 1, source: 'api', tickers: ['SMH'], byTicker: new Map([['SMH', { ready }]]) },
    });
    assert.equal(r.payload.custom_field, 'kept');
    assert.deepEqual(r.horizons_present, ['Daily']);      // only dS > 0
    assert.ok(r.warnings.some((w) => /No Weekly horizon.*keys are zero/.test(w)));
  });

  test('an unknown ticker throws WITH the coverage, not a bare failure', async () => {
    await assert.rejects(
      () => buildWallsJson({ symbol: 'NOPE', walls: walls({ Daily: horizon() }), vol }),
      (e) => /No wall data for NOPE/.test(e.message) && /coverage is 2 tickers/.test(e.message),
    );
  });

  test('json matches payload, since the indicator consumes the string', async () => {
    const r = await build({ Daily: horizon() });
    assert.deepEqual(JSON.parse(r.json), r.payload);
  });

  test('a missing symbol is refused', async () => {
    await assert.rejects(() => buildWallsJson({ walls: walls({}), vol }), /symbol is required/);
  });
});
