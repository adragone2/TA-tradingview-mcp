import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as data from '../core/data.js';
import { normalizeBars } from '../core/structure.js';
import * as momentum from '../core/momentum.js';
import * as vcp from '../core/vcp.js';
import * as kernel from '../core/kernel.js';
import * as lmw from '../core/lmw_patterns.js';
import * as validation from '../core/validation.js';
import * as breadth from '../core/breadth.js';
import * as stops from '../core/stops.js';
import * as horizon from '../core/horizon.js';
import * as selection from '../core/selection.js';
import * as costs from '../core/costs.js';
import * as crabel from '../core/crabel.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

/** Read bars and carry the series' own identity, so a result names its source. */
async function loadBars(count) {
  const series = await data.getOhlcv({ count, summary: false });
  const bars = normalizeBars(series);
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return { bars, symbol: series.symbol, timeframe: series.resolution };
}

export function registerEvidenceTools(server) {
  server.tool(
    'momentum_read',
    'Time-series momentum — the best-replicated effect in the technical literature, and the one this toolchain lacked. Moskowitz, Ooi & Pedersen found a 12-month lookback positive and significant for EVERY ONE of 58 futures over 25+ years (Sharpe 1.28 vs 0.38 buy-and-hold). Reads several horizons at once and says whether they AGREE — a name positive over 12 months and negative over 1 is in a pullback, not in momentum, and the mixed reading is the answer rather than a problem. Also reports the volatility scalar MOP used for sizing. Note the evidence is from DIVERSIFIED FUTURES: the signal transfers to a single equity, the Sharpe does not.',
    {
      count: z.coerce.number().optional().describe('Bars to load (default 500 — a 12-month lookback needs 253)'),
      lookback: z.coerce.number().optional().describe('Single-horizon lookback in bars. Omit to read all horizons (1m/3m/6m/12m)'),
    },
    wrap(async ({ count = 500, lookback = null }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      return {
        success: true, symbol, timeframe, bars: bars.length,
        ...(lookback
          ? momentum.timeSeriesMomentum(bars, { lookback })
          : momentum.momentumProfile(bars)),
        fifty_two_week_high: momentum.fiftyTwoWeekHigh(bars),
        persistence_baseline: momentum.persistenceBaseline(bars),
      };
    }),
  );

  server.tool(
    'vcp_check',
    'Minervini\'s volatility contraction pattern, as a measurable rule: successive pullbacks each tighter than the last, on declining volume, after a prior advance. Every clause is a number, and every check is reported with its value and requirement — so a near miss tells you WHICH clause failed instead of just "no". Measured selectivity: zero detections across 200 random walks, against 68% for our structural patterns and 43% for the Lo/Mamaysky/Wang definitions. A VCP is a SETUP, not a direction; nothing here forecasts the breakout.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 300)'),
      min_contractions: z.coerce.number().optional().describe('Minimum contractions required (default 3)'),
      max_final_pullback_pct: z.coerce.number().optional().describe('How tight the last contraction must be (default 12%)'),
      require_volume_dryup: z.coerce.boolean().optional().describe('Require declining volume through the contractions (default true)'),
    },
    wrap(async ({ count = 300, ...opts }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
      return {
        success: true, symbol, timeframe, bars: bars.length,
        ...vcp.detectVCP(bars, clean),
        noise_baseline: vcp.VCP_NOISE_BASELINE,
      };
    }),
  );

  server.tool(
    'pivots_kernel',
    'Locate swing pivots by kernel regression, then read each one from the ACTUAL bar high or low — the step from Lo, Mamaysky & Wang that keeps every reported price one that traded. Also returns the converging/diverging verdict measured BETWEEN REAL PIVOTS, which is the check that catches a detector describing its own fitted boundary lines instead of the price. On CSCO this reported diverging where the geometric detector reported converging; the pivots were right.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 300)'),
      bandwidth_multiplier: z.coerce.number().optional().describe('Multiple of the cross-validated bandwidth (default 1.0). LMW use 0.3; measured here, 0.3 finds 98.9 pivots per random walk against 73.9 at 1.0'),
      window_bars: z.coerce.number().optional().describe('Only use the last N bars'),
    },
    wrap(async ({ count = 300, bandwidth_multiplier = 1.0, window_bars = null }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      const seg = window_bars ? bars.slice(-window_bars) : bars;
      const out = kernel.findKernelPivots(seg, { bandwidth_multiplier });
      return {
        success: true, symbol, timeframe, bars_analysed: seg.length,
        ...out,
        width: kernel.pivotWidth(out.pivots),
      };
    }),
  );

  server.tool(
    'patterns_lmw',
    'The Lo/Mamaysky/Wang pattern definitions verbatim (head-and-shoulders, broadening, triangle, rectangle, double top/bottom) as a SECOND OPINION on patterns_detect — different pivot detector, different rules, so disagreement is informative. Ships with two facts that decide how to read it: the original 2000 result did NOT reproduce out of sample (Nekrasov 2010, "not anymore reproducible", only rectangle surviving), and these definitions match 43.4% of five-pivot windows drawn from PURE RANDOM WALKS. Never use as a screen; use where it disagrees with a selective detector.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 300)'),
      window: z.coerce.number().optional().describe('Rolling window in bars (default 38, the paper\'s l=35 + d=3). Pass 0 to scan the whole series'),
      bandwidth_multiplier: z.coerce.number().optional().describe('Kernel bandwidth multiple (default 1.0)'),
    },
    wrap(async ({ count = 300, window = 38, bandwidth_multiplier = 1.0 }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      return {
        success: true, symbol, timeframe, bars: bars.length,
        ...lmw.detectLmwPatterns(bars, { window: window || null, bandwidth_multiplier }),
      };
    }),
  );

  server.tool(
    'deflated_sharpe',
    'Correct a Sharpe ratio for how hard you looked for it. A Sharpe is a random variable: search 200 strategies with NO edge and the best scores an annualised Sharpe of 2.19 with a probabilistic Sharpe of 0.985 — measured, in this repo\'s tests. The deflated Sharpe is 0.267. Pass every trial\'s Sharpe (strongly preferred, because their spread is what makes the correction meaningful) or a trial count with an explicit variance. Below 0.95 is not a discovery. This is the single check missing from every scan and backtest here until now.',
    {
      returns: z.array(z.coerce.number()).describe('The strategy\'s per-period returns (or per-trade profits)'),
      trial_sharpes: z.array(z.coerce.number()).optional().describe('The Sharpe of EVERY variant you tested, including the losers. Strongly preferred'),
      trials: z.coerce.number().optional().describe('Number of trials, if you cannot supply their Sharpes'),
      sharpe_variance: z.coerce.number().optional().describe('Variance of the trial Sharpes — required when using `trials`'),
    },
    wrap(({ returns, trial_sharpes = null, trials = null, sharpe_variance = null }) => {
      if (!Array.isArray(returns) || returns.length < 8) {
        throw new Error(`Need at least 8 returns to say anything distributional; got ${returns?.length ?? 0}.`);
      }
      return {
        success: true,
        ...validation.deflatedSharpe(returns, { trial_sharpes, trials, sharpe_variance }),
        track_record: validation.minTrackRecordLength(returns),
      };
    }),
  );
  server.tool(
    'rule_select',
    'Select among candidate rules with transaction costs treated as ENDOGENOUS — the fix for the ordering error every scan in this repo made. Bajgrowicz & Scaillet: "Trading rules that survive the inclusion of transaction costs are often NOT among those that perform best before costs. Transaction costs must be treated as endogenous and not exogenous to the selection process." Ranking on gross return systematically favours high-turnover rules, which are precisely the rules costs destroy. This applies costs per signal BEFORE computing each rule\'s test statistic, selects by False Discovery Rate (which unlike White\'s Reality Check can select MULTIPLE surviving rules), and sweeps the cost level upward until nothing is detectable — giving an ex-ante BREAK-EVEN COST rather than requiring you to guess one. Also runs their persistence test, which asks whether the SELECTION PROCEDURE works at all: they found "an investor would never have been able to select ex ante the future best-performing rules." Note FDR needs a large candidate set; below ~50 rules it says so and points you to deflated_sharpe.',
    {
      candidates: z.array(z.object({
        name: z.string(),
        returns: z.array(z.coerce.number()).describe('Per-period returns, aligned in time across all candidates'),
        signals: z.coerce.number().describe('How many times this rule changed position over those periods — this is what makes cost endogenous'),
      })).describe('The candidate rules. Include EVERY variant you tried, not just the good ones'),
      mode: z.enum(['break_even', 'select', 'persistence']).optional().describe('break_even (default) sweeps cost until nothing survives; select runs one cost level; persistence tests the selection procedure'),
      cost_bps: z.coerce.number().optional().describe('Round-trip cost per signal, for select and persistence modes (default 10)'),
      gamma: z.coerce.number().optional().describe('p-value threshold for selection (default 0.10)'),
      max_bps: z.coerce.number().optional().describe('Upper bound for the break-even sweep (default 200)'),
      compare_at_bps: z.coerce.number().optional().describe('Your ACTUAL round-trip cost. Reports whether the gross winner is still the winner at that level — the practical form of the question'),
      train: z.coerce.number().optional().describe('Persistence mode: periods to select on (default 60)'),
      test: z.coerce.number().optional().describe('Persistence mode: periods to trade forward (default 21)'),
    },
    wrap(({ candidates, mode = 'break_even', cost_bps = 10, gamma = 0.10, max_bps = 200, train = 60, test = 21, compare_at_bps = null }) => {
      if (!Array.isArray(candidates) || !candidates.length) {
        throw new Error('candidates must be a non-empty array of {name, returns, signals}.');
      }
      if (mode === 'select') return { success: true, mode, ...selection.fdrSelect(candidates, { cost_bps, gamma }) };
      if (mode === 'persistence') return { success: true, mode, ...selection.persistenceTest(candidates, { train, test, cost_bps, gamma }) };
      return { success: true, mode, ...selection.breakEvenCost(candidates, { gamma, max_bps, compare_at_bps }) };
    }),
  );

  server.tool(
    'horizon_prior',
    'THE structural problem underneath swing trading, and the one this toolchain was silent about. Below ~21 trading days the dominant documented effect in equities is REVERSAL (Jegadeesh 1990, Lehmann 1990); above ~63 days it is CONTINUATION (Jegadeesh & Titman 1993). The standard momentum construction skips the most recent month precisely because the sign changes inside it — and that boundary falls INSIDE the swing window. So breakouts, flags, triangles and VCP all place a continuation bet at the horizon where continuation is WEAKEST, while oversold bounces and pullback entries are aligned with the effect that is actually documented there. Almost every detector in this repo is continuation-flavoured, which is a systematic tilt into the weaker side. Returns a PRIOR ADJUSTMENT, never a forecast. Also reports Nagel-style conditioning: the payoff to mean reversion is concentrated in high-volatility states, because it is compensation for supplying liquidity.',
    {
      setup: z.string().describe('Setup name, e.g. "bull_flag", "double_bottom", "vcp", "breakout"'),
      holding_days: z.coerce.number().optional().describe('Intended holding period in TRADING days (default 10)'),
      count: z.coerce.number().optional().describe('Bars to load for the volatility conditioning (default 500)'),
    },
    wrap(async ({ setup, holding_days = 10, count = 500 }) => {
      const prior = horizon.horizonPrior(setup, { holding_days });
      let conditioning = null;
      try {
        const { bars } = await loadBars(count);
        conditioning = horizon.reversalConditioning(bars);
      } catch { /* the prior stands without a chart */ }
      return { success: true, ...prior, ...(conditioning ? { volatility_conditioning: conditioning } : {}) };
    }),
  );

  server.tool(
    'turnover_cost',
    'Whether a strategy can survive its own trading frequency — the arithmetic that eliminates most swing systems before any signal work begins. Cost sensitivity scales with the INVERSE of holding period: a 5-day hold is ~50 round trips a year, and at 20bps each that consumes ~10% annually before any edge exists. Also computes the hysteresis exit from De Groot/Huij/Zhou, which more than halved turnover and costs while INCREASING net returns simply by waiting until a name crossed to the opposite half of the ranking instead of selling the moment it stopped qualifying — close to free, and almost no discretionary system does it. And measures signal-to-fill slippage from the actual bars, the systematically adverse gap between a close-based signal and the next open, which is separate from spread and commission.',
    {
      holding_days: z.coerce.number().optional().describe('Average holding period in trading days (default 5)'),
      round_trip_bps: z.coerce.number().optional().describe('Round-trip cost in basis points (default 20)'),
      entry_rank_pct: z.coerce.number().optional().describe('For hysteresis: percentile to enter at (default 20)'),
      exit_rank_pct: z.coerce.number().optional().describe('For hysteresis: percentile to exit at (default 50). Equal to entry = the naive max-turnover rule'),
      measure_slippage: z.coerce.boolean().optional().describe('Also measure close-to-next-open slippage from the loaded chart (default true)'),
      direction: z.enum(['long', 'short']).optional().describe('Direction for the slippage measurement (default long)'),
    },
    wrap(async ({ holding_days = 5, round_trip_bps = 20, entry_rank_pct = 20, exit_rank_pct = 50, measure_slippage = true, direction = 'long' }) => {
      const out = {
        success: true,
        drag: costs.turnoverDrag({ holding_days, round_trip_bps }),
        hysteresis: costs.hysteresisExit({ entry_rank_pct, exit_rank_pct, round_trip_bps, holding_days }),
      };
      if (measure_slippage) {
        try {
          const { bars, symbol, timeframe } = await loadBars(400);
          out.symbol = symbol; out.timeframe = timeframe;
          out.signal_to_fill_slippage = costs.signalToFillSlippage(bars, { direction });
        } catch (e) { out.slippage_note = `Could not measure from the chart: ${e.message}`; }
      }
      return out;
    }),
  );

  server.tool(
    'stopping_premium',
    'Does a stop-loss ADD expected return on this chart, or just cost you? Kaminski & Lo (2014) prove the stopping premium is ALWAYS NEGATIVE under a random walk — a stop then only forces you out of higher-yielding assets, and in their words "stop-loss rules never stop losses". It turns positive under momentum, directly proportional to return persistence. This measures autocorrelation at several lags with a significance band and reports which case the chart is in: persistent, no measurable persistence, mean-reverting (the worst case for a stop), or mixed. IMPORTANT: this is about expected return, NOT risk of ruin — a negative premium is a price, and bounding a loss is usually worth paying it. Use it to say WHICH reason a stop is being used for. Optionally backtests a specific stop threshold against buy-and-hold on the same bars.',
    {
      count: z.coerce.number().optional().describe('Bars to analyse (default 400)'),
      lags: z.string().optional().describe('Comma-separated lags to test (default "1,5,10,20"). Match the lag to how long the stop will be live'),
      backtest_threshold_pct: z.coerce.number().optional().describe('Also backtest a stop at this drawdown percent from entry'),
      cooldown_bars: z.coerce.number().optional().describe('Bars to stay out after a stop, for the backtest (default 5)'),
    },
    wrap(async ({ count = 400, lags = null, backtest_threshold_pct = null, cooldown_bars = 5 }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      const lagList = lags
        ? lags.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
        : undefined;
      return {
        success: true, symbol, timeframe,
        ...stops.stoppingPremium(bars, lagList ? { lags: lagList } : {}),
        ...(backtest_threshold_pct
          ? { backtest: stops.backtestStop(bars, { threshold_pct: backtest_threshold_pct, cooldown_bars }) }
          : {}),
      };
    }),
  );

  server.tool(
    'edge_breadth',
    'What a published cross-sectional edge is actually worth on YOUR number of positions. The Fundamental Law of Active Management (Grinold 1989): IR = IC * sqrt(breadth). An information ratio of 1.0 earned across 500 independent bets implies a skill coefficient of 0.045 — and applied to ONE position it returns an expected IR of 0.045, four percent of the headline. Every well-evidenced effect in this toolchain was measured across many instruments (momentum on 58 futures, the 52-week high on 1000+ stocks, PEAD on decile portfolios), so this division is the difference between quoting a study and misquoting it. Also carries the firm-level finding that PEAD largely dissolves on individual names.',
    {
      edge: z.enum(['time_series_momentum', 'fifty_two_week_high', 'post_earnings_drift']).optional().describe('A recorded published edge to translate'),
      published_ir: z.coerce.number().optional().describe('Published information ratio or Sharpe, for an edge not in the table'),
      study_breadth: z.coerce.number().optional().describe('How many INDEPENDENT bets the study made — usually its cross-section size'),
      your_positions: z.coerce.number().optional().describe('How many independent positions you would hold (default 1)'),
    },
    wrap(({ edge = null, published_ir = null, study_breadth = null, your_positions = 1 }) => {
      if (edge) return { success: true, ...breadth.singleNameExpectation(edge, { your_positions }), all_edges: breadth.PUBLISHED_EDGES };
      if (published_ir == null || study_breadth == null) {
        throw new Error('Supply either `edge`, or both `published_ir` and `study_breadth`.');
      }
      return { success: true, ...breadth.translateEdge({ published_ir, study_breadth, your_positions }) };
    }),
  );

  server.tool(
    'volatility_state',
    "Crabel's contraction/expansion measures, reported as a VOLATILITY STATE and never as a signal. Returns the multi-bar narrow ranges (2BNR/3BNR/4BNR/8BNR) — the narrowest N-day range against every other N-day period in a lookback, which NR4 and NR7 structurally cannot see because they compare single days. Also hooks, wide-spread days, 3DHR and the stretch. READ THE VERDICT BEFORE THE PATTERNS: the contraction/expansion principle these rest on has NO lift over noise. A narrow range is followed by a wider one 76.4% of the time on real data — and 80.2% of the time on a random walk, against a 50% base in both. Real data shows LESS lift than noise, because daily range is mean-reverting by arithmetic. Every pattern here fires on 100% of random walks. Use it to describe how coiled a market is; never to justify a direction or a trade.",
    {
      count: z.coerce.number().optional().describe('Bars to load (default 300 — the 8BNR lookback needs 48)'),
    },
    wrap(async ({ count = 300 }) => {
      const { bars, symbol, timeframe } = await loadBars(count);
      const out = crabel.crabelPatterns(bars);
      return {
        success: true, symbol, timeframe, bars: bars.length,
        ...out,
        verdict: crabel.CRABEL_NOISE_BASELINE.contraction_expansion.verdict,
        how_to_read: 'A contraction says a range expansion is likelier — and says nothing about direction. '
          + 'Take direction from structure_analyze or momentum_read. Quote the noise floor beside any detection.',
      };
    }),
  );
}
