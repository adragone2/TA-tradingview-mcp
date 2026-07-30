import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  DATASETS, REPORTING, DTC_SENTINELS, HOW_TO_USE, DAYS_TO_COVER_DRIVER_STUDY,
  daysBetween, staleness, decomposeDaysToCover, normalizeRow,
  periodVwap, shortsPosition, buildSeries, apiStatus,
} from '../src/core/finra.js';

/**
 * Fixtures are REAL rows pulled from the FINRA API on 2026-07-29, not invented
 * ones — a fabricated row would let a wrong field name pass.
 */
const PNC_2026_07_15 = {
  symbolCode: 'PNC', issueName: 'PNC Financial Services Group', marketClassCode: 'NYSE',
  settlementDate: '2026-07-15',
  currentShortPositionQuantity: 6700310, previousShortPositionQuantity: 7662068,
  averageDailyVolumeQuantity: 2245445, daysToCoverQuantity: 2.98,
  changePercent: -12.55, changePreviousNumber: -961758,
  stockSplitFlag: null, revisionFlag: null,
};
const PNC_2026_06_30 = {
  symbolCode: 'PNC', issueName: 'PNC Financial Services Group', marketClassCode: 'NYSE',
  settlementDate: '2026-06-30',
  currentShortPositionQuantity: 7662068, previousShortPositionQuantity: 7815657,
  averageDailyVolumeQuantity: 2735293, daysToCoverQuantity: 2.8,
  changePercent: -1.97, changePreviousNumber: -153589,
  stockSplitFlag: null, revisionFlag: null,
};
/** The clamp case: 34,636,195 / 38,275,532 = 0.905, reported as 1. */
const AAPL_CLAMPED = {
  symbolCode: 'AAPL', issueName: 'Apple Inc. Common Stock', marketClassCode: 'NNM',
  settlementDate: '2020-04-15',
  currentShortPositionQuantity: 34636195, previousShortPositionQuantity: 39059449,
  averageDailyVolumeQuantity: 38275532, daysToCoverQuantity: 1,
  changePercent: -11.32, changePreviousNumber: -4423254,
};

describe('dataset selection', () => {
  test('consolidated is the one that covers listed names, and says so', () => {
    // Choosing equityShortInterest for a listed symbol returns HTTP 204, which
    // reads as "no short interest" rather than "wrong dataset".
    assert.equal(DATASETS.consolidated.name, 'consolidatedShortInterest');
    assert.equal(DATASETS.consolidated.symbol_field, 'symbolCode');
    assert.match(DATASETS.consolidated.covers, /listed/i);
    assert.match(DATASETS.otc.covers, /204|OTC/);
  });

  test('the OTC dataset uses a different symbol field', () => {
    // Sending symbolCode to it is an HTTP 400 with "fields are not available".
    assert.equal(DATASETS.otc.symbol_field, 'issueSymbolIdentifier');
    assert.notEqual(DATASETS.otc.symbol_field, DATASETS.consolidated.symbol_field);
  });
});

describe('normalizeRow', () => {
  test('reads the consolidated field names', () => {
    const r = normalizeRow(PNC_2026_07_15);
    assert.equal(r.symbol, 'PNC');
    assert.equal(r.settlement_date, '2026-07-15');
    assert.equal(r.short_interest, 6700310);
    assert.equal(r.average_daily_volume, 2245445);
    assert.equal(r.market, 'NYSE');
  });

  test('also reads the OTC dataset field names', () => {
    const r = normalizeRow({
      issueSymbolIdentifier: 'XYZQ', settlementDate: '2026-07-15',
      currentShortShareNumber: 5000, previousShortShareNumber: 4000,
      averageShortShareNumber: 1000, daysToCoverNumber: 5,
      marketCategoryDescription: 'Non-Bulletin Board',
    });
    assert.equal(r.symbol, 'XYZQ');
    assert.equal(r.short_interest, 5000);
    assert.equal(r.days_to_cover_computed, 5);
  });

  test('RECOMPUTES days to cover past FINRA\'s 1.00 floor, and flags the clamp', () => {
    /**
     * The load-bearing case. FINRA's own field description: "1.00 will be
     * displayed for any values equal or less than 1". Inheriting that silently
     * makes an 0.9-day position look like a 1-day position, and makes every
     * sub-1 name indistinguishable from every other.
     */
    const r = normalizeRow(AAPL_CLAMPED);
    assert.equal(r.days_to_cover_reported, 1);
    assert.equal(r.days_to_cover_computed, 0.905);
    assert.equal(r.days_to_cover_clamped, true);
    assert.match(r.clamp_note, /1\.00/);
  });

  test('does not flag a clamp when the reported value is a real 1.00', () => {
    // Exactly 1.0 computed and 1.0 reported is agreement, not a clamp.
    const r = normalizeRow({
      symbolCode: 'X', settlementDate: '2026-07-15',
      currentShortPositionQuantity: 1000, averageDailyVolumeQuantity: 1000,
      daysToCoverQuantity: 1,
    });
    assert.equal(r.days_to_cover_computed, 1);
    assert.equal(r.days_to_cover_clamped, undefined);
  });

  test('flags the 999.99 ceiling as a clamp too', () => {
    // Real: AACAF on 2026-07-15 had 4,454,640 short against ADV of 2.
    const r = normalizeRow({
      symbolCode: 'AACAF', settlementDate: '2026-07-15',
      currentShortPositionQuantity: 4454640, averageDailyVolumeQuantity: 2,
      daysToCoverQuantity: 999.99,
    });
    assert.equal(r.days_to_cover_clamped, true);
    assert.ok(r.days_to_cover_computed > 999.99);
  });

  test('a zero average volume yields null, not Infinity', () => {
    const r = normalizeRow({
      symbolCode: 'Y', settlementDate: '2026-07-15',
      currentShortPositionQuantity: 272, averageDailyVolumeQuantity: 0,
      daysToCoverQuantity: 999.99,
    });
    assert.equal(r.days_to_cover_computed, null);
  });

  test('revision and split flags survive, because both change how a row reads', () => {
    const r = normalizeRow({ ...PNC_2026_07_15, revisionFlag: 'Y', stockSplitFlag: 'Y' });
    assert.equal(r.revised, true);
    assert.equal(r.split_adjusted, true);
  });
});

describe('decomposeDaysToCover — the flaw in Shannon\'s own Figure 15.1', () => {
  test('names AVERAGE VOLUME as the driver when the short position barely moved', () => {
    /**
     * Shannon's Figure 15.1, 12/31 -> 1/31: SIR collapses 12.91 -> 4.11 (-68%)
     * while short interest goes 19,276,055 -> 17,871,618, only -7%. Average
     * volume nearly tripled. Reading that as shorts capitulating is wrong, and
     * this is the guard against it.
     */
    const r = decomposeDaysToCover(
      { short_interest: 19276055, average_daily_volume: 1492816 },
      { short_interest: 17871618, average_daily_volume: 4345058 },
    );
    assert.equal(r.available, true);
    assert.equal(r.driver, 'average_volume');
    assert.ok(r.short_interest_change_pct > -10 && r.short_interest_change_pct < 0,
      `short interest moved ${r.short_interest_change_pct}%`);
    assert.ok(r.days_to_cover_change_pct < -60, `dtc moved ${r.days_to_cover_change_pct}%`);
    assert.ok(r.attribution.average_volume > r.attribution.short_interest);
    assert.match(r.note, /liquidity, not in short conviction/);
  });

  test('reproduces the real SIR figures from that decomposition', () => {
    // 19,276,055/1,492,816 = 12.91 and 17,871,618/4,345,058 = 4.11 — the
    // fixture is Shannon's table, so the arithmetic must land on his numbers.
    assert.equal(Math.round((19276055 / 1492816) * 100) / 100, 12.91);
    assert.equal(Math.round((17871618 / 4345058) * 100) / 100, 4.11);
  });

  test('names SHORT INTEREST as the driver when positioning is what moved', () => {
    const r = decomposeDaysToCover(
      { short_interest: 10000000, average_daily_volume: 2000000 },
      { short_interest: 20000000, average_daily_volume: 2000000 },
    );
    assert.equal(r.driver, 'short_interest');
    assert.equal(r.attribution.average_volume, 0);
    assert.match(r.note, /tracking positioning/);
  });

  test('attribution shares sum to 1', () => {
    const r = decomposeDaysToCover(
      { short_interest: 6700310, average_daily_volume: 2245445 },
      { short_interest: 7662068, average_daily_volume: 2735293 },
    );
    assert.ok(Math.abs(r.attribution.short_interest + r.attribution.average_volume - 1) < 0.002);
  });

  test('unavailable rather than a guess when a quantity is missing or zero', () => {
    for (const bad of [
      [{ short_interest: 0, average_daily_volume: 1 }, { short_interest: 1, average_daily_volume: 1 }],
      [{ short_interest: 1, average_daily_volume: 0 }, { short_interest: 1, average_daily_volume: 1 }],
      [null, { short_interest: 1, average_daily_volume: 1 }],
    ]) {
      assert.equal(decomposeDaysToCover(bad[0], bad[1]).available, false);
    }
  });
});

describe('staleness — a 200 is not freshness', () => {
  test('two weeks old is NORMAL for a bi-monthly series, not stale', () => {
    // Real: on 2026-07-29 the newest settlement date available was 2026-07-15.
    const s = staleness('2026-07-15', '2026-07-29');
    assert.equal(s.age_days, 14);
    assert.equal(s.stale, false);
    assert.match(s.verdict, /resolution of the measurement/);
  });

  test('past the threshold a scheduled report is missing, and it says the age', () => {
    const s = staleness('2026-06-15', '2026-07-29');
    assert.equal(s.age_days, 44);
    assert.equal(s.stale, true);
    assert.match(s.verdict, /44 days old/);
    assert.match(s.verdict, /Say the age out loud/);
  });

  test('the threshold is longer than one settlement interval', () => {
    // Otherwise every normal mid-cycle reading would be called stale.
    assert.ok(REPORTING.stale_after_days > 15);
  });

  test('an unparseable date is unavailable, not zero days old', () => {
    assert.equal(staleness('not-a-date', '2026-07-29').available, false);
    assert.equal(daysBetween('nope', '2026-07-29'), null);
  });
});

describe('periodVwap — the shorts\' estimated cost basis', () => {
  const day = (iso, price, volume) => ({
    time: Date.parse(`${iso}T13:30:00Z`),
    high: price + 1, low: price - 1, close: price, volume,
  });

  test('weights by volume and counts only bars inside the window', () => {
    const bars = [
      day('2026-06-20', 50, 100),   // before the window
      day('2026-07-01', 100, 1000),
      day('2026-07-10', 200, 3000),
      day('2026-08-01', 999, 5000), // after the window
    ];
    const v = periodVwap(bars, '2026-06-30', '2026-07-15');
    assert.equal(v.bars, 2);
    assert.equal(v.weighted, true);
    // (100*1000 + 200*3000) / 4000 = 175
    assert.equal(v.vwap, 175);
  });

  test('falls back to an unweighted mean when volume is unusable, and says so', () => {
    const v = periodVwap([day('2026-07-01', 100, 0), day('2026-07-10', 200, 0)], '2026-06-30', '2026-07-15');
    assert.equal(v.weighted, false);
    assert.equal(v.vwap, 150);
    assert.match(v.note, /unweighted/);
  });

  test('null rather than a number when the window is empty', () => {
    assert.equal(periodVwap([day('2026-01-01', 100, 1000)], '2026-06-30', '2026-07-15'), null);
    assert.equal(periodVwap([], '2026-06-30', '2026-07-15'), null);
    assert.equal(periodVwap(null, '2026-06-30', '2026-07-15'), null);
  });
});

describe('shortsPosition — squeeze fuel needs LOSING shorts', () => {
  test('price above the period VWAP means the shorts are underwater', () => {
    const r = shortsPosition(100, 120);
    assert.equal(r.shorts_underwater, true);
    assert.equal(r.shorts_pnl_pct, -20);
    assert.match(r.reading, /squeeze pressure/);
  });

  test('price below it means shorts hold gains and are NOT squeeze fuel', () => {
    /**
     * The asymmetry Shannon states: shorts with accumulated profits "are less
     * likely to panic and buy at the first signs of strength." Without this a
     * large short position in a falling stock reads as a squeeze setup, which
     * is his squeeze play #1 — the one he tells you not to trade.
     */
    const r = shortsPosition(100, 80);
    assert.equal(r.shorts_underwater, false);
    assert.equal(r.shorts_pnl_pct, 20);
    assert.match(r.reading, /NOT squeeze fuel/);
  });

  test('carries the caveat that a period VWAP is only a proxy', () => {
    assert.match(shortsPosition(100, 120).caveat, /crude proxy/);
  });

  test('unavailable on missing or nonsensical inputs', () => {
    assert.equal(shortsPosition(null, 120).available, false);
    assert.equal(shortsPosition(0, 120).available, false);
    assert.equal(shortsPosition(100, null).available, false);
  });
});

describe('buildSeries', () => {
  const rows = [PNC_2026_06_30, PNC_2026_07_15]; // deliberately out of order

  test('sorts newest first regardless of input order', () => {
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.series[0].settlement_date, '2026-07-15');
    assert.equal(s.series[1].settlement_date, '2026-06-30');
    assert.equal(s.latest.settlement_date, '2026-07-15');
  });

  test('reports raw short interest, ADV and days-to-cover SEPARATELY', () => {
    // Days-to-cover alone hides which of its two inputs moved.
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.latest.short_interest, 6700310);
    assert.equal(s.latest.average_daily_volume, 2245445);
    assert.ok(Number.isFinite(s.latest.days_to_cover));
    assert.ok('days_to_cover_reported' in s.latest);
  });

  test('short percent of float is explicitly n/a, never inferred', () => {
    // FINRA publishes no share count. Inventing one would be inventing a number.
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.latest.short_pct_of_float, null);
    assert.match(s.latest.short_pct_of_float_note, /NOT available/);
  });

  test('decomposes the latest period against the prior one', () => {
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.vs_prior_period.available, true);
    // SI -12.6%, ADV -17.9% — both moved, so the driver is a real judgement.
    assert.ok(['short_interest', 'average_volume'].includes(s.vs_prior_period.driver));
  });

  test('summarises the recent trend direction', () => {
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.recent_trend.direction, 'covering'); // 7.66M -> 6.70M
    assert.equal(s.recent_trend.periods, 2);
  });

  test('carries freshness on every result', () => {
    const s = buildSeries(rows, { asOf: '2026-07-29' });
    assert.equal(s.freshness.age_days, 14);
    assert.equal(s.freshness.stale, false);
  });

  test('THROWS without asOf rather than silently reading the clock', () => {
    // A result whose staleness depends on when it ran is not reproducible.
    assert.throws(() => buildSeries(rows, {}), /asOf/);
  });

  test('periods truncates AFTER sorting, keeping the NEWEST rows', () => {
    /**
     * Regression for a bug the live run caught and the unit tests could not.
     * FINRA returns rows oldest-first and its `limit` drops from the newest end,
     * so slicing before sorting throws away the most recent settlement dates —
     * and the staleness check then reports 75-day-old data, which reads as a
     * FINRA outage rather than as a paging bug.
     */
    const many = ['2026-01-15', '2026-02-13', '2026-03-13', '2026-04-15', '2026-05-15', '2026-06-30', '2026-07-15']
      .map((d, i) => ({
        symbolCode: 'PNC', settlementDate: d,
        currentShortPositionQuantity: 6000000 + i * 100000,
        previousShortPositionQuantity: 6000000 + (i - 1) * 100000,
        averageDailyVolumeQuantity: 2000000, daysToCoverQuantity: 3,
      }));
    const s = buildSeries(many, { asOf: '2026-07-29', periods: 3 });
    assert.equal(s.periods, 3);
    assert.deepEqual(s.series.map((r) => r.settlement_date), ['2026-07-15', '2026-06-30', '2026-05-15']);
    // And therefore the freshness is right rather than 6 months stale.
    assert.equal(s.freshness.age_days, 14);
    assert.equal(s.freshness.stale, false);
  });

  test('periods never cuts below the two rows a decomposition needs', () => {
    const s = buildSeries(rows, { asOf: '2026-07-29', periods: 1 });
    assert.equal(s.periods, 2);
    assert.equal(s.vs_prior_period.available, true);
  });

  test('an empty row set is unavailable, not an error', () => {
    assert.equal(buildSeries([], { asOf: '2026-07-29' }).available, false);
    assert.equal(buildSeries(null, { asOf: '2026-07-29' }).available, false);
  });

  test('attaches period VWAP and the shorts\' P&L when bars are supplied', () => {
    const bars = [];
    for (let d = 1; d <= 15; d += 1) {
      bars.push({
        time: Date.parse(`2026-07-${String(d).padStart(2, '0')}T13:30:00Z`),
        high: 101, low: 99, close: 100, volume: 1000,
      });
    }
    const s = buildSeries(rows, { asOf: '2026-07-29', bars, lastPrice: 130 });
    assert.equal(s.series[0].period_vwap, 100);
    assert.equal(s.shorts_position.shorts_underwater, true);
  });

  test('the oldest period gets no VWAP, because it has no start boundary', () => {
    const bars = [{ time: Date.parse('2026-07-10T13:30:00Z'), high: 101, low: 99, close: 100, volume: 1000 }];
    const s = buildSeries(rows, { asOf: '2026-07-29', bars });
    assert.equal(s.series[s.series.length - 1].period_vwap, undefined);
  });
});

describe('the guidance travels with the data', () => {
  test('says outright that this is context, not a signal', () => {
    assert.match(HOW_TO_USE.role, /CONTEXT, not a signal/);
    assert.match(HOW_TO_USE.shannon, /by itself is not a reason/);
  });

  test('warns against every failure this module was built to prevent', () => {
    const joined = HOW_TO_USE.do_not.join(' ');
    assert.match(joined, /days-to-cover alone/);
    assert.match(joined, /clamped/);
    assert.match(joined, /float/);
    assert.match(joined, /valuation|P\/E/);
  });

  test('states the losing-shorts asymmetry', () => {
    assert.match(HOW_TO_USE.the_asymmetry, /LOSING/);
  });

  test('cites its source', () => {
    assert.match(HOW_TO_USE.source, /Rule 4560/);
    assert.match(HOW_TO_USE.source, /Shannon/);
  });

  test('the sentinel values are documented as clamps', () => {
    assert.equal(DTC_SENTINELS.floor, 1.0);
    assert.equal(DTC_SENTINELS.ceiling, 999.99);
    assert.match(DTC_SENTINELS.note, /clamps, not measurements/);
  });

  test('the driver study carries its sample size, not just its headline', () => {
    /**
     * A result without a trial count flatters itself. 93% means nothing without
     * 458 big moves out of 1000 period changes across 40 symbols.
     */
    const s = DAYS_TO_COVER_DRIVER_STUDY;
    assert.equal(s.big_moves_driven_by_volume_pct, 93.0);
    assert.equal(s.big_moves, 458);
    assert.equal(s.big_moves_driven_by_volume, 426);
    assert.equal(s.period_changes, 1000);
    assert.equal(s.symbols, 40);
    // The headline must be reproducible from the raw counts.
    assert.equal(Math.round((426 / 458) * 1000) / 10, 93.0);
    assert.match(s.script, /short-interest-driver/);
  });

  test('every series ships the driver study, so the caveat cannot be lost', () => {
    const s = buildSeries([PNC_2026_06_30, PNC_2026_07_15], { asOf: '2026-07-29' });
    assert.equal(s.days_to_cover_driver_study.big_moves_driven_by_volume_pct, 93.0);
  });
});

describe('apiStatus', () => {
  test('reports configuration without exposing a credential', () => {
    const s = apiStatus();
    assert.equal(s.success, true);
    assert.equal(typeof s.credentials_configured, 'boolean');
    const dumped = JSON.stringify(s);
    // Whatever the env holds, neither secret may appear in the response.
    for (const key of ['FINRA_CLIENT_ID', 'FINRA_CLIENT_SECRET']) {
      const v = process.env[key];
      if (v && v.length > 6) assert.ok(!dumped.includes(v), `${key} leaked into apiStatus output`);
    }
  });

  test('names the dataset in use and the reporting cadence', () => {
    const s = apiStatus();
    assert.equal(s.dataset, 'consolidatedShortInterest');
    assert.match(s.reporting.settlement_cadence, /[Tt]wice monthly/);
  });
});
