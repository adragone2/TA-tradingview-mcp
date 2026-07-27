/**
 * Portfolio-level risk: heat, correlation, and concentration.
 *
 * `risk.js` sizes ONE trade. That is the wrong unit for the question that
 * actually ends accounts, which is what happens when several positions go wrong
 * at once — and they do go wrong at once, because the thing that moves one
 * position usually moves the others.
 *
 * Six positions risking 1% each is not 1% of risk. If they are all long
 * semiconductors it is closer to one 6% position wearing six names, and the
 * per-trade sizing that looked conservative was never conservative at all.
 *
 * Three measurements:
 *   heat        — total risk if every open stop is hit
 *   correlation — how much the positions actually move together
 *   concentration — how much sits in one bucket
 *
 * Correlation is computed from returns where the caller supplies them, and
 * declared unknown where they do not. Assuming independence is the error this
 * module exists to prevent, so it is never assumed silently.
 *
 * All pure. Nothing here places an order.
 */
const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Total open risk — "heat" — if every stop is hit at once.
 *
 * Each position needs entry, stop and shares. Positions whose stop sits at or
 * beyond break-even contribute zero and are reported separately: a stop moved
 * to entry has genuinely removed that risk, and counting it inflates heat.
 */
export function portfolioHeat(positions, { account_size, max_heat_pct = 6 } = {}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return { available: false, note: 'No positions supplied.' };
  }
  const acct = Number(account_size);
  if (!(acct > 0)) return { available: false, note: 'account_size must be positive.' };

  const rows = [], skipped = [];
  let total = 0, riskFree = 0;

  for (const p of positions) {
    const { symbol = '?', entry, stop, shares, direction = 'long' } = p || {};
    if (![entry, stop, shares].every((v) => Number.isFinite(Number(v)))) {
      skipped.push({ symbol, why: 'entry, stop and shares must all be numbers' });
      continue;
    }
    const long = direction !== 'short';
    // A stop at or past entry has locked in a gain (or scratch) — no risk left.
    const perShare = long ? Number(entry) - Number(stop) : Number(stop) - Number(entry);
    const risk = Math.max(0, perShare) * Number(shares);
    if (risk === 0) riskFree++;
    total += risk;
    rows.push({
      symbol,
      direction: long ? 'long' : 'short',
      risk: round(risk, 2),
      risk_pct: round((risk / acct) * 100, 3),
      at_or_past_breakeven: perShare <= 0,
      notional: round(Number(entry) * Number(shares), 2),
    });
  }

  const heatPct = (total / acct) * 100;
  rows.sort((a, b) => b.risk - a.risk);

  return {
    available: true,
    positions: rows,
    open_positions: rows.length,
    risk_free_positions: riskFree,
    total_risk: round(total, 2),
    heat_pct: round(heatPct, 3),
    max_heat_pct: round(max_heat_pct, 2),
    within_limit: heatPct <= max_heat_pct,
    largest_position: rows[0] || null,
    ...(skipped.length ? { skipped } : {}),
    verdict: heatPct > max_heat_pct
      ? `Heat is ${round(heatPct, 2)}%, over the ${max_heat_pct}% limit. If every stop is hit the account loses that much — and stops tend to be hit together, not one at a time.`
      : `Heat is ${round(heatPct, 2)}%, within the ${max_heat_pct}% limit.`,
    caveat: 'Heat assumes every stop fills at its price. Gaps fill worse, so real heat is higher than this — see gap_risk. It also treats positions as independent, which they are not; run position_correlation.',
  };
}

/**
 * How much the open positions actually move together.
 *
 * Pearson correlation on the return series supplied per symbol. Where returns
 * are missing the pair is reported as UNKNOWN rather than assumed independent —
 * assuming independence is exactly the mistake this measures.
 *
 * `effective_positions` is the useful summary: N positions with an average
 * pairwise correlation of r behave roughly like N / (1 + (N-1)·r) independent
 * ones. Six positions at r = 0.8 are about 1.4 independent bets.
 */
export function positionCorrelation(returnsBySymbol = {}, { min_points = 20 } = {}) {
  const symbols = Object.keys(returnsBySymbol);
  if (symbols.length < 2) {
    return { available: false, note: 'Need return series for at least two symbols.' };
  }

  const corr = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (n < min_points) return null;
    const x = a.slice(-n), y = b.slice(-n);
    const mx = x.reduce((s, v) => s + v, 0) / n;
    const my = y.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a1 = x[i] - mx, b1 = y[i] - my;
      num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
  };

  const pairs = [], unknown = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i], b = symbols[j];
      const r = corr(returnsBySymbol[a] || [], returnsBySymbol[b] || []);
      if (r == null) { unknown.push([a, b]); continue; }
      pairs.push({
        pair: [a, b],
        correlation: round(r, 3),
        strength: Math.abs(r) >= 0.8 ? 'very high' : Math.abs(r) >= 0.6 ? 'high' : Math.abs(r) >= 0.3 ? 'moderate' : 'low',
      });
    }
  }

  if (!pairs.length) {
    return {
      available: false,
      unknown_pairs: unknown.length,
      note: `No pair had ${min_points} overlapping return points. Correlation is UNKNOWN — which is not the same as zero, and treating it as zero is the error this measures.`,
    };
  }

  const avg = pairs.reduce((s, p) => s + p.correlation, 0) / pairs.length;
  const n = Object.keys(returnsBySymbol).length;
  const effective = avg <= -1 / (n - 1) ? n : n / (1 + (n - 1) * Math.max(0, avg));

  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return {
    available: true,
    pairs,
    pairs_measured: pairs.length,
    unknown_pairs: unknown.length,
    ...(unknown.length ? { unknown_note: `${unknown.length} pair(s) had too little overlapping data and are UNKNOWN, not zero.` } : {}),
    average_correlation: round(avg, 3),
    most_correlated: pairs[0],
    position_count: n,
    effective_positions: round(effective, 2),
    interpretation: avg >= 0.6
      ? `Average pairwise correlation is ${round(avg, 2)}. These ${n} positions behave like roughly ${round(effective, 1)} independent bets — the diversification is mostly nominal, and per-trade sizing understates the real risk.`
      : avg >= 0.3
        ? `Average pairwise correlation is ${round(avg, 2)}. ${n} positions behave like about ${round(effective, 1)} independent ones.`
        : `Average pairwise correlation is ${round(avg, 2)} — these positions are close to independent, so the per-trade sizing roughly holds.`,
    caveat: 'Correlation measured over the supplied window. It is not stable: correlations rise sharply in a selloff, which is precisely when the diversification is being relied on.',
  };
}

/**
 * Concentration by any bucket — sector, asset class, direction, whatever the
 * caller tags positions with.
 *
 * Reported by RISK rather than by notional. Two positions of equal size with
 * very different stop distances carry very different risk, and notional hides
 * that entirely.
 */
export function concentration(positions, { key = 'sector', account_size = null } = {}) {
  if (!Array.isArray(positions) || !positions.length) {
    return { available: false, note: 'No positions supplied.' };
  }

  const buckets = new Map();
  let total = 0, untagged = 0;

  for (const p of positions) {
    const { entry, stop, shares, direction = 'long' } = p || {};
    if (![entry, stop, shares].every((v) => Number.isFinite(Number(v)))) continue;
    const long = direction !== 'short';
    const risk = Math.max(0, long ? Number(entry) - Number(stop) : Number(stop) - Number(entry)) * Number(shares);
    const tag = p[key] ?? null;
    if (tag == null) untagged++;
    const name = tag ?? 'untagged';
    buckets.set(name, (buckets.get(name) || 0) + risk);
    total += risk;
  }

  if (total === 0) return { available: false, note: 'Total risk is zero — every stop is at or past break-even.' };

  const rows = [...buckets.entries()]
    .map(([bucket, risk]) => ({
      bucket,
      risk: round(risk, 2),
      share_pct: round((risk / total) * 100, 1),
      ...(account_size > 0 ? { pct_of_account: round((risk / account_size) * 100, 3) } : {}),
    }))
    .sort((a, b) => b.risk - a.risk);

  const top = rows[0];
  return {
    available: true,
    key,
    buckets: rows,
    total_risk: round(total, 2),
    largest_bucket: top,
    ...(untagged ? { untagged_positions: untagged, untagged_note: `${untagged} position(s) had no "${key}" tag and are grouped as untagged. Concentration cannot be judged for those.` } : {}),
    interpretation: top.share_pct >= 50
      ? `${top.share_pct}% of open risk sits in a single ${key} (${top.bucket}). That is one bet in several names, not a diversified book.`
      : `Largest ${key} holds ${top.share_pct}% of open risk.`,
    note: 'Measured by RISK, not notional. Two equal-sized positions with different stop distances carry different risk, and notional hides that.',
  };
}
