/**
 * Rule selection with transaction costs treated as ENDOGENOUS.
 *
 * After Bajgrowicz & Scaillet (2012), "Technical trading revisited: false
 * discoveries, persistence tests, and transaction costs", JFE 106(3), 473-491.
 *
 * ── The bug this fixes ──
 *
 * Every scan and backtest in this repo ranks candidates first and applies
 * costs afterwards. Bajgrowicz & Scaillet show that ordering produces the
 * wrong winners:
 *
 *   "It does not make sense to first select a portfolio of trading rules using
 *    the RW method or our FDR approach and then compute the portfolio
 *    break-even costs. Trading rules that survive the inclusion of transaction
 *    costs are often NOT among those that perform best before costs.
 *    Transaction costs must be treated as endogenous and not exogenous to the
 *    selection process."
 *
 * The reason is mechanical. A rule that trades 200 times a year and one that
 * trades 12 have completely different cost burdens, so ranking on gross return
 * systematically favours the high-turnover rule — which is exactly the rule
 * costs will destroy. Rank on gross, cost afterwards, and you have selected
 * for the thing you are about to be punished for.
 *
 * ── Their fix, implemented here ──
 *
 * Rather than guessing a cost level, SWEEP it upward, re-running selection at
 * every level, until nothing survives. That level is the **ex-ante break-even
 * cost**:
 *
 *   "by increasing transaction costs until the FDR approach is not able to
 *    detect any positive performance. They can be viewed as break-even
 *    transaction costs computed ex ante."
 *
 * The output is not "this rule earns X" but "this set of rules stops being
 * detectable above Y basis points" — which is directly comparable to what you
 * actually pay.
 *
 * ── Why FDR rather than the Reality Check ──
 *
 * White's Reality Check tests only the single best rule and, once it meets a
 * rule whose performance is luck, is "by construction unable to select further
 * rules". The False Discovery Rate tolerates a known small proportion of false
 * positives and therefore selects MULTIPLE surviving rules, which allows
 * diversification against model uncertainty.
 *
 * FDR+ is estimated as F+/R+ after Barras, Scaillet & Wermers (2010), where R+
 * is the number of rules selected as significantly positive and F+ the
 * estimated number of those that are false discoveries. **An FDR+ of 100%
 * means no rule delivers genuine positive returns and the apparent performance
 * is pure data snooping.**
 *
 * All pure.
 */
import { normalCdf } from './validation.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Net a rule's returns of transaction costs, charged PER SIGNAL.
 *
 * This is where turnover enters selection. `signals` is the number of times
 * the rule changed position over the same periods the returns cover.
 */
export function netOfCosts({ returns, signals, cost_bps }) {
  if (!Array.isArray(returns) || !returns.length) throw new Error('returns must be a non-empty array.');
  if (!(signals >= 0)) throw new Error('signals must be a non-negative count.');
  if (!(cost_bps >= 0)) throw new Error('cost_bps must be non-negative.');

  const total = returns.reduce((a, b) => a + b, 0);
  const costTotal = (signals * cost_bps) / 10000;
  const perPeriodCost = costTotal / returns.length;
  return {
    net_returns: returns.map((r) => r - perPeriodCost),
    gross_total: total,
    cost_total: costTotal,
    net_total: total - costTotal,
    signals,
    cost_bps,
  };
}

/** Two-sided t-test p-value for "mean return is zero". */
function pValueOfMean(returns) {
  const n = returns.length;
  if (n < 3) return { p: 1, t: 0, mean: 0 };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1));
  if (sd === 0) return { p: mean === 0 ? 1 : 0, t: mean === 0 ? 0 : Infinity, mean };
  const t = mean / (sd / Math.sqrt(n));
  // Normal approximation to the t distribution; adequate at the sample sizes
  // this is used on, and stated rather than hidden.
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { p: Math.min(1, Math.max(0, p)), t, mean };
}

/**
 * Storey's estimator of the proportion of rules with NO genuine performance.
 *
 * pi0 = #(p > lambda) / ((1 - lambda) * l). Under the null, p-values are
 * uniform, so the tail above lambda estimates how much of the population is
 * null. A pi0 near 1 means almost nothing in the candidate set is real.
 */
export function estimatePi0(pvalues, { lambda = 0.6 } = {}) {
  const l = pvalues.length;
  if (!l) return 1;
  if (!(lambda > 0 && lambda < 1)) throw new Error('lambda must be strictly between 0 and 1.');
  const above = pvalues.filter((p) => p > lambda).length;
  return Math.min(1, above / ((1 - lambda) * l));
}

/**
 * Select rules by FDR+, at a given cost level.
 *
 * `candidates` is `[{ name, returns, signals }]`. Costs are applied BEFORE the
 * test statistic is computed — that is the whole point.
 */
export function fdrSelect(candidates, { cost_bps = 0, gamma = 0.10, lambda = 0.6 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error('candidates must be a non-empty array of {name, returns, signals}.');
  }
  if (!(gamma > 0 && gamma < 1)) throw new Error('gamma (the p-value threshold) must be between 0 and 1.');

  const scored = candidates.map((c) => {
    const net = netOfCosts({ returns: c.returns, signals: c.signals ?? 0, cost_bps });
    const stat = pValueOfMean(net.net_returns);
    return {
      name: c.name,
      signals: net.signals,
      gross_total: round(net.gross_total, 6),
      cost_total: round(net.cost_total, 6),
      net_total: round(net.net_total, 6),
      mean_net: round(stat.mean, 8),
      t: round(stat.t, 3),
      p: round(stat.p, 5),
    };
  });

  const pvals = scored.map((s) => s.p);
  const pi0 = estimatePi0(pvals, { lambda });
  const l = scored.length;

  // Significantly positive: p <= gamma AND mean net return > 0.
  const selected = scored.filter((s) => s.p <= gamma && s.mean_net > 0);
  const rPlus = selected.length;
  // Expected false positives on the positive side. The gamma/2 splits the
  // two-sided rejection region between the positive and negative tails.
  const fPlus = pi0 * (gamma / 2) * l;
  const fdrPlus = rPlus > 0 ? Math.min(1, fPlus / rPlus) : null;

  // FDR needs a large candidate set to have any power. Expected false
  // positives on the positive side are pi0 * (gamma/2) * l, and if that
  // exceeds the number of selections then FDR+ pins at 100% however real the
  // edge is. Measured: with 21 candidates and one genuine edge, F+ = 1.05
  // against R+ = 1, so nothing is detectable. The same edge among 201
  // candidates is detected. Bajgrowicz & Scaillet tested 7,846 rules.
  const underpowered = fPlus >= 1 && l < 50;

  return {
    cost_bps,
    gamma,
    candidates_tested: l,
    ...(underpowered
      ? {
          underpowered: true,
          power_warning: `Only ${l} candidates. Expected false positives on the positive side are `
            + `${round(fPlus, 2)}, so FDR+ cannot fall meaningfully below 100% no matter how real an edge is. `
            + 'This is the method working, not failing — FDR is designed for large candidate sets, and Bajgrowicz & '
            + 'Scaillet ran it over 7,846 rules. Below roughly 50 candidates use deflated_sharpe on the single '
            + 'best rule instead, which is built for that case.',
        }
      : {}),
    pi0: round(pi0, 4),
    selected: selected.sort((a, b) => b.mean_net - a.mean_net),
    selected_count: rPlus,
    estimated_false_positives: round(fPlus, 2),
    fdr_plus: fdrPlus == null ? null : round(fdrPlus, 4),
    detects_positive_performance: rPlus > 0 && fdrPlus != null && fdrPlus < 1,
    verdict: rPlus === 0
      ? `No rule is significantly positive at ${cost_bps}bps. The FDR approach detects nothing.`
      : fdrPlus >= 1
        ? `${rPlus} rules look positive, but the estimated false-discovery rate is 100% — the apparent performance is pure data snooping.`
        : `${rPlus} rules selected with an estimated FDR+ of ${round(fdrPlus * 100, 1)}% — roughly ${Math.round(fPlus)} of them are expected to be false.`,
    method: 'Costs are applied to each rule BEFORE its test statistic is computed, so turnover enters the selection '
      + 'rather than being deducted from the winner afterwards.',
    p_value_note: 'p-values from a two-sided t-test on the mean net return, normal approximation. Bajgrowicz & Scaillet '
      + 'use a studentized bootstrap that accounts for serial and cross-sectional dependence; this is the simpler '
      + 'version and will be slightly liberal.',
  };
}

/**
 * THE FIX: the ex-ante break-even transaction cost.
 *
 * Sweeps the cost level upward, re-running selection at each level, until the
 * FDR approach can no longer detect any positive performance. That level is
 * the answer, and it removes the need to pick a cost in advance.
 *
 * Compare it against what you actually pay. If your real cost is above the
 * break-even, the rule set does not survive — and note that the rules selected
 * at 0bps are usually NOT the rules selected at the break-even level, which is
 * the entire point.
 */
export function breakEvenCost(candidates, { gamma = 0.10, lambda = 0.6, max_bps = 200, step_bps = 1, compare_at_bps = null } = {}) {
  if (!(max_bps > 0 && step_bps > 0)) throw new Error('max_bps and step_bps must be positive.');

  const path = [];
  let breakEven = null;
  let atZero = null;

  for (let bps = 0; bps <= max_bps; bps += step_bps) {
    const r = fdrSelect(candidates, { cost_bps: bps, gamma, lambda });
    if (bps === 0) atZero = r;
    path.push({
      cost_bps: bps,
      selected: r.selected_count,
      fdr_plus: r.fdr_plus,
      top_rule: r.selected[0]?.name ?? null,
    });
    if (!r.detects_positive_performance) { breakEven = bps; break; }
  }

  const survivorsAtBreakEven = breakEven != null && breakEven > 0
    ? fdrSelect(candidates, { cost_bps: Math.max(0, breakEven - step_bps), gamma, lambda })
    : null;

  // Did the identity of the winner change as costs rose? This is the claim
  // that makes the ordering matter, so it is checked across the WHOLE sweep
  // rather than only at the endpoints — a low break-even leaves too narrow a
  // window for an endpoint comparison to see anything.
  const zeroTop = atZero?.selected[0]?.name ?? null;
  const topRules = path.map((p) => p.top_rule).filter(Boolean);
  const topChangedAt = path.find((p) => p.top_rule && p.top_rule !== zeroTop) ?? null;

  const zeroNames = new Set((atZero?.selected ?? []).map((s) => s.name));
  const lastNames = (survivorsAtBreakEven?.selected ?? []).map((s) => s.name);
  const changed = lastNames.filter((n) => !zeroNames.has(n));

  // The practical question is not "who wins at break-even" but "does MY cost
  // change the winner". The sweep stops at break-even, so a ranking flip that
  // happens beyond it is invisible above — this asks directly, at any level.
  let atYourCost = null;
  if (compare_at_bps != null) {
    const r = fdrSelect(candidates, { cost_bps: compare_at_bps, gamma, lambda });
    const grossOrder = (atZero?.selected ?? []).map((s) => s.name);
    const netOrder = r.selected.map((s) => s.name);
    atYourCost = {
      cost_bps: compare_at_bps,
      top_rule_gross: grossOrder[0] ?? null,
      top_rule_net: netOrder[0] ?? null,
      winner_changes_at_your_cost: (grossOrder[0] ?? null) !== (netOrder[0] ?? null),
      dropped_once_costed: grossOrder.filter((n) => !netOrder.includes(n)).slice(0, 10),
      still_detectable: r.detects_positive_performance,
      note: (grossOrder[0] ?? null) !== (netOrder[0] ?? null)
        ? `At ${compare_at_bps}bps the best rule is "${netOrder[0]}", NOT the gross winner "${grossOrder[0]}". `
          + 'Ranking on gross and costing afterwards would have picked the wrong rule — this is the error in one line.'
        : `At ${compare_at_bps}bps the gross winner still leads. The ordering did not change here, which is worth `
          + 'knowing but is not guaranteed at another cost level.',
      ...(breakEven != null && compare_at_bps >= breakEven
        ? { beyond_break_even: `Note ${compare_at_bps}bps is at or above the break-even of ${breakEven}bps, so the FDR `
            + 'approach no longer detects genuine performance here — this comparison shows the ranking, not a viable strategy.' }
        : {}),
    };
  }

  return {
    break_even_bps: breakEven,
    reached_max: breakEven == null,
    ...(atYourCost ? { at_your_cost: atYourCost } : {}),
    selected_at_zero_cost: atZero?.selected_count ?? 0,
    top_rule_at_zero_cost: atZero?.selected[0]?.name ?? null,
    last_surviving_cost_bps: breakEven != null ? Math.max(0, breakEven - step_bps) : max_bps,
    survivors_at_break_even: survivorsAtBreakEven?.selected.map((s) => s.name) ?? [],
    top_rule_at_break_even: survivorsAtBreakEven?.selected[0]?.name ?? null,
    // Checked across the entire sweep, not just at its endpoints.
    winners_changed_with_cost: topChangedAt != null || changed.length > 0,
    top_rule_first_changed_at_bps: topChangedAt?.cost_bps ?? null,
    top_rule_after_change: topChangedAt?.top_rule ?? null,
    distinct_top_rules_across_sweep: [...new Set(topRules)],
    rules_that_only_survive_with_costs: changed,
    path,
    interpretation: breakEven == null
      ? `Still detecting positive performance at ${max_bps}bps. Either the edge is very large or the candidate set is small enough that the FDR estimate is unstable.`
      : `The FDR approach stops detecting any positive performance at ${breakEven}bps. That is the ex-ante break-even cost. `
        + 'If your real round-trip cost is at or above it, this rule set does not survive.',
    why_this_ordering: 'Costs are applied BEFORE selection at every level, so the ranking changes as costs rise. '
      + 'Bajgrowicz & Scaillet: "Trading rules that survive the inclusion of transaction costs are often not among '
      + 'those that perform best before costs."',
    source: 'Bajgrowicz & Scaillet (2012), JFE 106(3). Their approach: increase transaction costs until the FDR '
      + 'approach cannot detect any positive performance.',
  };
}

/**
 * Persistence test: does the SELECTION PROCEDURE work, or only the hindsight?
 *
 * Their most damning result is not that rules fail statistically, but that the
 * identity of the winner does not persist:
 *
 *   "an investor would never have been able to select ex ante the future
 *    best-performing rules."
 *
 * The design: select rules on one window using FDR at a realistic cost, trade
 * that selection in the NEXT window, roll forward, and measure the realised
 * out-of-sample return. This tests the apparatus, not a rule — and a strategy
 * whose selection procedure is noise is worthless however good the in-sample
 * winner looks.
 *
 * `candidates[i].returns` must all be the same length and aligned in time.
 */
export function persistenceTest(candidates, { train = 60, test = 21, cost_bps = 10, gamma = 0.10, lambda = 0.6 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) throw new Error('candidates must be a non-empty array.');
  const n = candidates[0].returns.length;
  if (candidates.some((c) => c.returns.length !== n)) {
    throw new Error('All candidates must have return series of the same length, aligned in time.');
  }
  if (n < train + test) {
    return { available: false, note: `Need at least ${train + test} periods, have ${n}.` };
  }

  const windows = [];
  for (let start = 0; start + train + test <= n; start += test) {
    const trainSlice = candidates.map((c) => ({
      name: c.name,
      returns: c.returns.slice(start, start + train),
      // Scale the signal count to the window, so cost per period stays right.
      signals: Math.round(((c.signals ?? 0) / n) * train),
    }));
    const sel = fdrSelect(trainSlice, { cost_bps, gamma, lambda });
    const chosen = sel.selected.map((s) => s.name);

    // Trade the selection in the NEXT window, net of the same costs.
    let realised = null;
    if (chosen.length) {
      const per = chosen.map((name) => {
        const c = candidates.find((x) => x.name === name);
        const slice = c.returns.slice(start + train, start + train + test);
        const sig = Math.round(((c.signals ?? 0) / n) * test);
        return netOfCosts({ returns: slice, signals: sig, cost_bps }).net_total;
      });
      realised = per.reduce((a, b) => a + b, 0) / per.length;   // equal-weighted portfolio of selected rules
    }

    // What the best rule in the test window would have returned, for contrast.
    const oracle = Math.max(...candidates.map((c) => {
      const slice = c.returns.slice(start + train, start + train + test);
      const sig = Math.round(((c.signals ?? 0) / n) * test);
      return netOfCosts({ returns: slice, signals: sig, cost_bps }).net_total;
    }));

    windows.push({
      window: windows.length,
      train_from: start,
      selected_count: chosen.length,
      selected: chosen.slice(0, 5),
      realised_next_period: realised == null ? null : round(realised, 6),
      best_possible_next_period: round(oracle, 6),
    });
  }

  const traded = windows.filter((w) => w.realised_next_period != null);
  const mean = traded.length ? traded.reduce((a, w) => a + w.realised_next_period, 0) / traded.length : null;
  const positive = traded.filter((w) => w.realised_next_period > 0).length;

  // Does the winner in one window predict the winner in the next?
  let carried = 0, comparable = 0;
  for (let i = 1; i < windows.length; i++) {
    if (!windows[i - 1].selected.length || !windows[i].selected.length) continue;
    comparable++;
    if (windows[i].selected.includes(windows[i - 1].selected[0])) carried++;
  }

  return {
    available: true,
    windows: windows.length,
    windows_with_a_selection: traded.length,
    mean_out_of_sample_return: mean == null ? null : round(mean, 6),
    positive_windows: positive,
    positive_window_pct: traded.length ? round((positive / traded.length) * 100, 1) : null,
    top_rule_reselected_pct: comparable ? round((carried / comparable) * 100, 1) : null,
    cost_bps,
    detail: windows,
    verdict: mean == null ? 'No window produced a selection — the procedure never fired.'
      : mean > 0
        ? `The selection procedure produced a positive mean out-of-sample return of ${round(mean, 6)} per window across ${traded.length} windows.`
        : `The selection procedure produced a NEGATIVE mean out-of-sample return (${round(mean, 6)}). Choosing rules this way did not work, whatever the in-sample winner looked like.`,
    what_is_being_tested: 'The PROCEDURE, not a rule. Rules are re-selected every window using only prior data, then '
      + 'traded forward. A high in-sample winner with a failing persistence test means the selection apparatus is noise.',
    source: 'Bajgrowicz & Scaillet (2012): "an investor would never have been able to select ex ante the future '
      + 'best-performing rules." They found no hot-hands phenomenon in technical trading rules.',
  };
}
