import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  exchangeParts, sessionState, resolutionSeconds, isIntraday, periodUnit,
  lastBarState, completeBars, scannerTrust, SCANNER_FIELD_RISK, US_EQUITY_SESSION,
} from '../src/core/session.js';

/** 2026-07-29 is a Wednesday. EDT is UTC-4 in July. */
const ET = (iso) => Date.parse(iso);
const WED_0800_ET = ET('2026-07-29T12:00:00Z');
const WED_1143_ET = ET('2026-07-29T15:43:00Z');
const WED_1630_ET = ET('2026-07-29T20:30:00Z');
const SAT_1200_ET = ET('2026-08-01T16:00:00Z');

/**
 * Read off the LIVE chart (BATS:NUE, 1D) on 2026-07-29 at 11:43 ET.
 *
 * These three timestamps pin TradingView's daily-bar convention, which is the
 * single assumption the whole guard rests on. They decode to 09:30 ET — the
 * session open in EXCHANGE time, not UTC midnight. Had it been UTC midnight,
 * every daily bar would decode to 20:00 ET on the PREVIOUS day and the date
 * test would be silently off by one, passing partial bars through as finished.
 */
const NUE = [
  { time: 1785159000, open: 249.12, high: 251.23, low: 244.04, close: 247.86, volume: 1686721 },
  { time: 1785245400, open: 254, high: 268.44, low: 253.99, close: 265.62, volume: 2580210 },
  { time: 1785331800, open: 268.94, high: 270.02, low: 256.62, close: 256.91, volume: 560387 },
];

describe('the exchange clock', () => {
  test('decodes an epoch to exchange-local date and minutes', () => {
    const p = exchangeParts(WED_1143_ET);
    assert.equal(p.date, '2026-07-29');
    assert.equal(p.minutes, 11 * 60 + 43);
    assert.equal(p.weekday, 'Wed');
  });

  test('does NOT report UTC — the whole guard depends on this', () => {
    // 20:30 UTC is still 16:30 on the same ET day. A UTC reading would say
    // 20:30, which would put a 16:00 close test on the wrong side.
    assert.equal(exchangeParts(WED_1630_ET).minutes, 16 * 60 + 30);
    assert.notEqual(exchangeParts(WED_1630_ET).minutes, 20 * 60 + 30);
  });

  test('names each part of the trading day', () => {
    assert.equal(sessionState(WED_0800_ET).state, 'premarket');
    assert.equal(sessionState(WED_1143_ET).state, 'open');
    assert.equal(sessionState(WED_1630_ET).state, 'closed');
    assert.equal(sessionState(SAT_1200_ET).state, 'weekend');
  });

  test('the boundaries fall on the right side', () => {
    assert.equal(sessionState(ET('2026-07-29T13:29:00Z')).state, 'premarket'); // 09:29
    assert.equal(sessionState(ET('2026-07-29T13:30:00Z')).state, 'open');      // 09:30
    assert.equal(sessionState(ET('2026-07-29T19:59:00Z')).state, 'open');      // 15:59
    assert.equal(sessionState(ET('2026-07-29T20:00:00Z')).state, 'closed');    // 16:00
  });
});

describe("TradingView's daily-bar timestamp convention", () => {
  test('daily bars are stamped at the SESSION OPEN in exchange time', () => {
    for (const bar of NUE) {
      assert.equal(exchangeParts(bar.time * 1000).minutes, 9 * 60 + 30,
        'a daily bar no longer decodes to 09:30 ET — the date test is now off by one');
    }
  });

  test('the three live bars land on three consecutive weekdays', () => {
    assert.deepEqual(NUE.map((b) => exchangeParts(b.time * 1000).date),
      ['2026-07-27', '2026-07-28', '2026-07-29']);
  });
});

describe('resolution parsing', () => {
  test('a bare number is minutes', () => {
    assert.equal(resolutionSeconds('5'), 300);
    assert.equal(resolutionSeconds('60'), 3600);
    assert.equal(resolutionSeconds('240'), 14400);
  });

  test('daily and above are session-based, not duration-based', () => {
    // Returning 86400 here would be the tempting wrong answer: a daily bar is
    // finished when the SESSION closes at 16:00, not 24h after it opened.
    assert.equal(resolutionSeconds('1D'), null);
    assert.equal(resolutionSeconds('D'), null);
    assert.equal(resolutionSeconds('W'), null);
    assert.equal(resolutionSeconds('1M'), null);
    assert.equal(isIntraday('1D'), false);
    assert.equal(isIntraday('15'), true);
  });

  test('seconds resolutions parse', () => {
    assert.equal(resolutionSeconds('30S'), 30);
    assert.equal(resolutionSeconds('S'), 1);
  });

  test('period unit is recovered for session-based resolutions', () => {
    assert.equal(periodUnit('1D'), 'D');
    assert.equal(periodUnit('W'), 'W');
    assert.equal(periodUnit('15'), null);
  });
});

describe('the partial-bar verdict on daily bars', () => {
  test('a bar dated today is PARTIAL while the session is open', () => {
    const s = lastBarState(NUE, { resolution: '1D', now: WED_1143_ET });
    assert.equal(s.complete, false);
    assert.equal(s.session_state, 'open');
  });

  test('a bar dated today is PARTIAL pre-open — the case the screen hits', () => {
    // The morning screen runs 05:30 PT / 08:30 ET. This is the bug.
    const s = lastBarState(NUE, { resolution: '1D', now: WED_0800_ET });
    assert.equal(s.complete, false);
    assert.equal(s.session_state, 'premarket');
  });

  test('the same bar is COMPLETE once the session has closed', () => {
    const s = lastBarState(NUE, { resolution: '1D', now: WED_1630_ET });
    assert.equal(s.complete, true);
  });

  test('a bar dated before today is complete regardless of the clock', () => {
    const s = lastBarState(NUE.slice(0, 2), { resolution: '1D', now: WED_1143_ET });
    assert.equal(s.complete, true);
    assert.match(s.reason, /2026-07-28/);
  });

  test('weekends and holidays need no special case', () => {
    // On a non-session day the newest bar simply is not dated today, so the
    // date test already answers it. No holiday calendar required.
    const s = lastBarState(NUE, { resolution: '1D', now: SAT_1200_ET });
    assert.equal(s.complete, true);
  });
});

describe('what a partial bar actually corrupts', () => {
  test('high, low and volume are named — close and open are NOT', () => {
    /**
     * This distinction is the point. The close of a forming bar is a real live
     * quote and stays usable as a price; treating the whole bar as garbage
     * would throw away good information. The range and the volume are what
     * lie.
     */
    const s = lastBarState(NUE, { resolution: '1D', now: WED_1143_ET });
    assert.deepEqual(s.corrupts.sort(), ['high', 'low', 'volume']);
    assert.ok(!s.corrupts.includes('close'));
    assert.ok(!s.corrupts.includes('open'));
  });

  test('a complete bar corrupts nothing', () => {
    assert.deepEqual(lastBarState(NUE, { resolution: '1D', now: WED_1630_ET }).corrupts, []);
  });
});

describe('intraday completeness', () => {
  const base = 1785331800; // 09:30 ET
  const fiveMin = [{ time: base, open: 1, high: 2, low: 1, close: 2, volume: 10 }];

  test('a bar still inside its own duration is partial', () => {
    const s = lastBarState(fiveMin, { resolution: '5', now: (base + 120) * 1000 });
    assert.equal(s.complete, false);
    assert.match(s.reason, /180s to go/);
  });

  test('a bar past its duration is complete', () => {
    const s = lastBarState(fiveMin, { resolution: '5', now: (base + 301) * 1000 });
    assert.equal(s.complete, true);
  });

  test('the boundary closes the bar exactly at its end', () => {
    assert.equal(lastBarState(fiveMin, { resolution: '5', now: (base + 300) * 1000 }).complete, true);
    assert.equal(lastBarState(fiveMin, { resolution: '5', now: (base + 299) * 1000 }).complete, false);
  });
});

describe('completeBars', () => {
  test('drops exactly the forming bar and hands it back', () => {
    const r = completeBars(NUE, { resolution: '1D', now: WED_1143_ET });
    assert.equal(r.bars.length, 2);
    assert.equal(r.dropped_count, 1);
    // Handed back, not discarded — a stop check still wants the live price.
    assert.equal(r.dropped.close, 256.91);
    assert.match(r.note, /volume/);
  });

  test('leaves a finished series untouched', () => {
    const r = completeBars(NUE, { resolution: '1D', now: WED_1630_ET });
    assert.equal(r.bars.length, 3);
    assert.equal(r.dropped, null);
    assert.equal(r.note, null);
  });

  test('an empty series is not an error, and not a claim of completeness', () => {
    const r = completeBars([], { resolution: '1D', now: WED_1143_ET });
    assert.equal(r.state.complete, null);
    assert.equal(r.dropped_count, 0);
  });

  test('a bar with no timestamp yields null, never a false "complete"', () => {
    // Guessing "complete" on unreadable input is how a partial bar gets in.
    const s = lastBarState([{ open: 1, high: 2, low: 1, close: 2 }], { resolution: '1D' });
    assert.equal(s.complete, null);
  });
});

describe('scanner fields cannot be repaired, only declared', () => {
  test('volume fields are unusable while the session is live', () => {
    const t = scannerTrust(WED_1143_ET);
    assert.equal(t.volume_fields_usable, false);
    assert.match(t.reason, /partial day/);
  });

  test('volume fields are usable once the day is done', () => {
    assert.equal(scannerTrust(WED_1630_ET).volume_fields_usable, true);
    assert.equal(scannerTrust(SAT_1200_ET).volume_fields_usable, true);
  });

  test('the field the high-volume premium ranks on is listed UNSAFE', () => {
    /**
     * factors.js ranks the Gervais/Kaniel/Mingelgrin premium on
     * relative_volume_10d_calc. Pre-open that field reflects a fraction of a
     * day, so the decile sort inverts. This is the concrete damage.
     */
    assert.ok(SCANNER_FIELD_RISK.unsafe.includes('relative_volume_10d_calc'));
    assert.ok(!SCANNER_FIELD_RISK.safe.includes('relative_volume_10d_calc'));
  });

  test('moving averages are DEGRADED, not unsafe — the distinction is deliberate', () => {
    // A 20-day average whose newest input is a real quote is diluted 1/20, not
    // wrong. Calling it unsafe would discard the Tier A factors for no reason.
    assert.ok(SCANNER_FIELD_RISK.degraded.includes('SMA20'));
    assert.ok(SCANNER_FIELD_RISK.degraded.includes('SMA200'));
    assert.ok(!SCANNER_FIELD_RISK.unsafe.includes('SMA20'));
  });

  test('the session used is the US equities regular session', () => {
    assert.equal(US_EQUITY_SESSION.open_minutes, 570);
    assert.equal(US_EQUITY_SESSION.close_minutes, 960);
  });
});
