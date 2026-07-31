/**
 * Equal-weight against cap-weight — is money LEAVING, or rotating?
 *
 * The S&P 500 is dominated by a handful of mega-caps, so SPY can fall while most of
 * its members rise, and it can rise while most of them fall. RSP holds the same 500
 * names at equal weight. The SPREAD between them is a statement about BREADTH that
 * neither index makes alone:
 *
 *   RSP outperforming  ->  the average member is doing better than the index says.
 *                          A cap-weighted drawdown here is concentrated, not broad.
 *   SPY outperforming  ->  the index is being carried. Most members are lagging what
 *                          the headline number implies.
 *
 * Measured 2026-07-30: SPY +0.1% on the month against RSP +1.2%, with QQQ at −5.6%.
 * The headline looked soft while the average S&P member was fine — money rotating
 * out of mega-cap tech, not out of equities.
 *
 * ── What this is NOT ──
 *
 * Not a signal, and not a gate. This repo has forward-tested three market/trend
 * alignment gates and all three failed (`level_pressure` out of sample,
 * `stage_plan` on forward returns, Livermore's two-leader agreement at −9.3 points).
 * Nothing here has been tested as a predictor and it must not be used as one.
 *
 * It is CONTEXT — the same standing as `group_context`: it says what the market is
 * doing, so a broad drawdown and a narrow one are not written up the same way. The
 * distinction is descriptive and checkable, which is the whole of its claim.
 *
 * Pure: takes scanner rows, returns a reading.
 */

/** The pairs worth comparing, and what a divergence in each one means. */
export const BREADTH_PAIRS = Object.freeze([
  {
    key: 'sp500',
    equal: 'RSP',
    cap: 'SPY',
    note: 'Same 500 names, equal weight vs cap weight. The cleanest read available: '
      + 'identical constituents, so the spread is weighting alone and nothing else.',
  },
  {
    key: 'nasdaq100',
    equal: 'QQQE',
    cap: 'QQQ',
    note: 'Same 100 names. Mega-cap concentration is heaviest here, so this pair moves first.',
  },
]);

const WINDOWS = Object.freeze([
  { field: 'Perf.W', label: '1w' },
  { field: 'Perf.1M', label: '1m' },
  { field: 'Perf.3M', label: '3m' },
  { field: 'Perf.6M', label: '6m' },
  { field: 'Perf.Y', label: '1y' },
]);

/** Columns a caller must request for `equalWeightBreadth` to have anything to read. */
export const BREADTH_COLUMNS = Object.freeze(['name', 'close', ...WINDOWS.map((w) => w.field)]);

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/**
 * A number, or null — never a silent zero.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so a bare `Number()` turns an ABSENT
 * performance field into a real-looking value. Downstream that becomes a 0.0
 * spread, which reads as "even — no meaningful weighting divergence": a finding,
 * conjured from a field that was never there. Same principle as `evalClause`
 * returning UNKNOWN rather than false for a missing column.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object[]} rows Scanner rows covering the ETFs in BREADTH_PAIRS.
 * @returns {{pairs: object[], summary: string, available: boolean}}
 */
export function equalWeightBreadth(rows = []) {
  const by = new Map();
  for (const r of rows || []) {
    const t = String(r?.symbol ?? r?.name ?? '').split(':').pop().toUpperCase();
    if (t) by.set(t, r);
  }

  const pairs = [];
  for (const p of BREADTH_PAIRS) {
    const eq = by.get(p.equal);
    const cap = by.get(p.cap);
    if (!eq || !cap) {
      pairs.push({
        ...p,
        available: false,
        /**
         * Missing is reported, never treated as zero. A spread of 0.0 reads as
         * "breadth is neutral", which is a finding; an absent ETF is not.
         */
        why: `${!eq ? p.equal : p.cap} was not in the rows supplied — request BREADTH_COLUMNS `
          + 'over a universe that includes ETFs (the index-member universes do not).',
      });
      continue;
    }
    const spreads = {};
    for (const w of WINDOWS) {
      const a = num(eq[w.field]);
      const b = num(cap[w.field]);
      spreads[w.label] = (a !== null && b !== null) ? r2(a - b) : null;
    }
    // The 1-month spread is the headline: long enough to be more than noise, short
    // enough to describe the current rotation rather than last year's.
    const head = spreads['1m'];
    pairs.push({
      ...p,
      available: true,
      equal_perf: Object.fromEntries(WINDOWS.map((w) => [w.label, r2(num(eq[w.field]))])),
      cap_perf: Object.fromEntries(WINDOWS.map((w) => [w.label, r2(num(cap[w.field]))])),
      spread_pts: spreads,
      /**
       * Deliberately coarse. A tenth of a point is not a regime, and a finer scale
       * would invite reading precision this has never been tested to carry.
       */
      reading: head == null ? 'unknown'
        : head > 1 ? 'broad — the average member is beating the index'
          : head < -1 ? 'narrow — the index is being carried by its largest names'
            : 'even — no meaningful weighting divergence',
    });
  }

  const live = pairs.filter((p) => p.available);
  return {
    available: live.length > 0,
    pairs,
    summary: live.length
      ? live.map((p) => `${p.equal} vs ${p.cap}: ${p.spread_pts['1m'] > 0 ? '+' : ''}`
        + `${p.spread_pts['1m']} pts over 1m (${String(p.reading).split(' —')[0]})`).join('; ')
      : 'no breadth pair could be computed',
    not_a_signal: 'CONTEXT only. Untested as a predictor here, and this repo has forward-tested '
      + 'three market-alignment gates that all failed. Use it to describe whether a drawdown is '
      + 'broad or concentrated — never as a reason to take or skip a trade.',
  };
}
