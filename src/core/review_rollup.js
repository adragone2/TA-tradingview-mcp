/**
 * Report-wide rollups for the Sunday review.
 *
 * Extracted from scripts/sunday-review.js so the computation is CALLABLE.
 * The market_condition block spent months as an inline IIFE reading schema-1.0
 * key paths after the 2.0 move — a dead optional chain yields
 * `undefined`, not an error, so it emitted `{regime_counts: {}, broad_chop: false}` on every
 * real report and read as "the market is fine". The fix (P0.6) came with a
 * source contract banning 1.0 paths in the script; this extraction exists
 * because a source contract pins spelling, not behaviour — a neutered
 * condition passes every regex (the P2.4 lesson). A pure function can be fed
 * a fixture report and asserted to actually POPULATE.
 *
 * Pure. The script imports this; nothing here touches a chart or the clock.
 */

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * The week's market-wide condition, computed over the analysed rows.
 * Rows are 2.0-shaped: `t.analysis.assessment.market_regime`. A 1.0-shaped
 * row contributes nothing — deliberately, and the test asserts BOTH halves:
 * populated on 2.0 rows, empty-but-honest on 1.0 rows.
 */
export function marketCondition(ok) {
  const regs = (ok || []).map((t) => t.analysis?.assessment?.market_regime?.regime).filter(Boolean);
  const choppy = regs.filter((r) => r === 'choppy').length;
  const share = regs.length ? choppy / regs.length : null;
  const effs = (ok || []).map((t) => t.analysis?.assessment?.market_regime?.efficiency)
    .filter((e) => e != null).sort((a, b) => a - b);
  return {
    regime_counts: regs.reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
    choppy_share_pct: share == null ? null : r2(share * 100, 1),
    median_efficiency: effs.length ? effs[Math.floor(effs.length / 2)] : null,
    random_walk_efficiency: (ok || [])[0]?.analysis?.assessment?.market_regime?.random_walk_efficiency ?? null,
    broad_chop: share != null && share >= 0.5,
    note: share != null && share >= 0.5
      ? `${r2(share * 100, 1)}% of names are below the 0.3 efficiency gate. This is a statement about the WEEK'S `
        + 'MARKET, not about the individual names, and it is why "high conviction into chop" is recorded as a '
        + 'conflict rather than a contradiction — a flag that fires on most rows does not discriminate.'
      : null,
  };
}
