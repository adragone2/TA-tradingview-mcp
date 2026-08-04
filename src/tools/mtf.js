import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/mtf.js';
import * as data from '../core/data.js';
import { normalizeBars, findSwings, alternateSwings, classifyStructure } from '../core/structure.js';
import { regime } from '../core/context.js';
import { scaleTimeframe, scalingExponent } from '../core/timeframe.js';
import * as stages from '../core/stages.js';
import { stageHistory, stageDrawPlan, drawStageHistory, CYCLE_LABEL_GRAMMAR } from '../core/stage_history.js';
import * as drawing from '../core/drawing.js';
import { removeOrphans } from '../core/orphans.js';
// `atrFromBars` rather than strategy.js's `atr`: identical arithmetic, no import
// chain. It is the same one `drawFindings` sizes its callout displacement with.
import { atrFromBars } from '../core/level_display.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

/** "10,20,50" -> [10,20,50], or Shannon's daily triple. Shared by the three stage tools. */
function parsePeriods(periods) {
  if (!periods) return stages.MA_SETS.daily;
  const mas = String(periods).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (mas.length !== 3) throw new Error('periods needs exactly three moving-average lengths, e.g. "10,20,50".');
  return mas;
}

/**
 * Median seconds per bar, for anything placed in BAR units on the time axis.
 *
 * Not 86400: a daily chart across a weekend measures ~120,960s and an intraday one
 * measures its own resolution. Same derivation `drawFindings` uses.
 */
function barSecondsOf(bars) {
  return (bars?.length ?? 0) > 11
    ? Math.max(1, Math.round((bars.at(-1).time - bars.at(-11).time) / 10))
    : 86400;
}

/** Read one screen: trend, regime, and where price sits. */
function screenOf(bars, label, lookback) {
  if (bars.length < lookback * 2 + 5) {
    return { label, trend: 'undetermined', regime: 'unknown', bars: bars.length,
      note: `Only ${bars.length} bars at ${label} — not enough to read structure. Load more history.` };
  }
  const s = classifyStructure(alternateSwings(findSwings(bars, { lookback })));
  const r = regime(bars, { window: Math.min(30, bars.length) });
  const last = bars[bars.length - 1];

  // Typical bar range on this timeframe, which is what a stop placed here
  // costs. This is the practical payoff of the trigger screen: a stop the
  // width of a weekly bar and a stop the width of an hourly bar aim at the
  // same target and produce very different R:R.
  const recent = bars.slice(-20);
  const avgRange = recent.reduce((a, b) => a + (b.high - b.low), 0) / recent.length;

  return {
    label,
    trend: s.trend,
    regime: r.regime,
    efficiency: r.efficiency,
    bars: bars.length,
    last_close: last.close,
    typical_bar_range: Math.round(avgRange * 1e6) / 1e6,
    typical_bar_range_pct: Math.round((avgRange / last.close) * 1e4) / 1e2,
    last_swing_high: s.last_high ? s.last_high.price : null,
    last_swing_low: s.last_low ? s.last_low.price : null,
    recent_events: s.events.slice(-2).map((e) => `${e.type}/${e.direction}`),
  };
}

export function registerMtfTools(server) {
  server.tool(
    'timeframe_plan',
    'Which timeframes to use for a trading style, and why. Timeframes step by a factor of 4-6 (Elder\'s "factor of five") into three screens: CONTEXT grants permission, STRUCTURE finds the setup, TRIGGER times the entry. For US equities swing is weekly/daily/1H — NOT 4H, because a 6.5-hour session makes a 4H bar only ~1.6x a daily; use swing_24h for crypto and FX. Day trading is daily/1H/15m. Also reports what entering on the lower screen is worth: most of the R:R gain in multi-timeframe trading comes from a tighter stop, not a better signal.',
    {
      style: z.enum(['position', 'swing', 'swing_24h', 'short_swing', 'day', 'scalp']).optional().describe('Trading style (omit to see all plans)'),
      timeframes: z.string().optional().describe('Check a custom set instead, highest first, e.g. "1W,1D,1H"'),
      session_hours: z.coerce.number().optional().describe('Trading hours per session — 6.5 for US equities (default), 24 for crypto and FX. The same timeframes space very differently'),
    },
    wrap(({ style, timeframes, session_hours }) => {
      if (timeframes) {
        const tfs = timeframes.split(',').map((s) => s.trim()).filter(Boolean);
        return { success: true, timeframes: tfs, spacing: core.checkSpacing(tfs, { session_hours: session_hours ?? 6.5 }), plans: core.TIMEFRAME_PLANS };
      }
      if (style) {
        const p = core.TIMEFRAME_PLANS[style];
        return {
          success: true, style, ...p,
          screens: { context: p.context, structure: p.structure, trigger: p.trigger },
          spacing: core.checkSpacing([p.context, p.structure, p.trigger], { session_hours: session_hours ?? p.session_hours ?? 6.5 }),
          rule: 'The CONTEXT timeframe grants permission and the STRUCTURE timeframe finds the setup against it. A signal on the structure timeframe pointing against the context timeframe is a countertrend trade, not a signal.',
        };
      }
      return { success: true, plans: core.TIMEFRAME_PLANS, note: 'Pick by holding period, not preference. Someone holding for weeks who executes off a 5-minute chart has chosen the wrong trigger.' };
    }),
  );

  server.tool(
    'mtf_analyze',
    'Trend and regime across three timeframes at once, and whether they AGREE. Higher timeframes are built by aggregating the loaded bars, so the chart is never switched and nothing can be left on the wrong symbol. Reports which direction the context timeframe permits — a daily setup against a weekly downtrend is countertrend, and this is what says so. Flags a partial newest higher-timeframe bar, which is the commonest way multi-timeframe analysis misleads.',
    {
      count: z.coerce.number().optional().describe('Bars of the loaded timeframe to use (default 500)'),
      base_label: z.string().optional().describe('Name of the loaded timeframe, e.g. "1D" (default "base")'),
      lookback: z.coerce.number().optional().describe('Swing sensitivity (default 5)'),
      higher: z.string().optional().describe('How to aggregate: "week,month" for a daily chart, or bar multiples like "4,20" for intraday (default week,month)'),
    },
    wrap(async ({ count = 500, base_label = 'base', lookback = 5, higher = 'week,month' }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');

      const steps = higher.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));

      const screens = [];
      const warnings = [];
      for (const step of [...steps].reverse()) {           // highest first
        const r = core.resampleBars(bars, step);
        const label = typeof step === 'number' ? `${base_label} x${step}` : step;
        const sc = screenOf(r.bars, label, lookback);
        sc.resampled_from = base_label;
        sc.partial_last_bar = r.partial_last_bar;
        if (r.partial_warning) { sc.partial_warning = r.partial_warning; warnings.push(`${label}: ${r.partial_warning}`); }
        if (sc.note) warnings.push(`${label}: ${sc.note}`);
        screens.push(sc);
      }
      screens.push(screenOf(bars, base_label, lookback));

      // Quantify what entering on the lower screen is worth. A stop sized to
      // the context bar and one sized to the trigger bar chase the same target.
      const ctx = screens[0], trg = screens[screens.length - 1];
      const entry_precision = (ctx.typical_bar_range_pct && trg.typical_bar_range_pct)
        ? {
            context_bar_pct: ctx.typical_bar_range_pct,
            trigger_bar_pct: trg.typical_bar_range_pct,
            stop_ratio: Math.round((ctx.typical_bar_range_pct / trg.typical_bar_range_pct) * 100) / 100,
            meaning: `A stop sized to a ${ctx.label} bar is ${Math.round((ctx.typical_bar_range_pct / trg.typical_bar_range_pct) * 10) / 10}x wider than one sized to a ${trg.label} bar. Entering on the lower screen aims at the same target with a smaller stop, which is where most of the R:R improvement in multi-timeframe trading comes from — not from a better signal, from a tighter one.`,
            caveat: 'A tighter stop is only better if it is still outside normal noise on the timeframe you entered. Check it with position_size_atr before using it.',
          }
        : null;

      return {
        success: true,
        screens,
        alignment: core.alignment(screens),
        ...(entry_precision ? { entry_precision } : {}),
        ...(warnings.length ? { warnings } : {}),
        method: 'Higher timeframes are aggregated from the loaded bars — the chart was not switched. This only works upward; a trigger timeframe below the loaded one has to be looked at directly.',
        caveat: 'Each timeframe reads its trend from CONFIRMED swings, so each lags by its own lookback. The higher the timeframe, the longer that lag in calendar time.',
      };
    }),
  );

  server.tool(
    'timeframe_scale',
    'Translate a method from one timeframe to another. Two quantities scale DIFFERENTLY and conflating them is how "the same setup on a faster chart" becomes a different strategy: LOOKBACKS scale linearly with the timeframe ratio (Shannon 2008 — 65 bars on 30min and 195 on 10min both span 5 sessions), while STOPS, TARGETS and RANGES scale as its SQUARE ROOT (Grimes 2013 — a 1.5pt stop on 5min becomes 5.2 on hourly). Scaling a stop linearly is the common error and makes it several times too wide.',
    {
      from: z.string().describe('Source resolution, e.g. "1D", "60", "5"'),
      to: z.string().describe('Target resolution'),
      lookback_bars: z.coerce.number().optional().describe('An indicator lookback to translate (scales linearly)'),
      price_distance: z.coerce.number().optional().describe('A stop/target distance to translate (scales as sqrt)'),
    },
    wrap(({ from, to, lookback_bars, price_distance }) => ({
      success: true, ...scaleTimeframe({ from, to, lookback_bars, price_distance }),
    })),
  );

  server.tool(
    'scaling_exponent',
    'The realised volatility scaling exponent on this chart. The sqrt-of-time law assumes 0.5, which holds only under independence — so measuring it tests the assumption. Above 0.5 moves COMPOUND (persistence, the continuation side); below 0.5 they OFFSET (mean reversion, the reversal side). This makes the reversal-versus-continuation boundary a property of the series in front of you rather than a citation. Cross-checks stopping_premium, which measures the same thing via autocorrelation.',
    {
      count: z.coerce.number().optional().describe('Bars to examine (default 400)'),
    },
    wrap(async ({ count = 400 }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      return { success: true, ...scalingExponent(bars) };
    }),
  );

  server.tool(
    'stage_plan',
    'Shannon\'s four-stage ACTION machine: what to DO right now, from two timeframes. The longer one is a GATE — "the only stocks which should be of ANY interest are those in an established Stage 2 Uptrend or a Stage 4 Decline", so Stages 1 and 3 return NO_SETUP rather than a weaker signal. The shorter one then decides: on a Stage 2 gate, short-TF Stage 1 = ANTICIPATE (stalk, set an alert, do not buy), Stage 2 = PARTICIPATE, Stage 3 = EXIT, Stage 4 = AVOID. The short side is the same wheel rotated by two. Each stage is Shannon\'s own three-clause definition — price above/below all three averages, all three sloping the same way, and correctly STACKED 10>20>50 (stacking is a separate clause: all three can rise while still crossed) — so the clauses can DISAGREE and the classifier abstains. That abstention is the point: measured, it declines to name a stage on 54% of random walks, where Wyckoff\'s classifyPhase names one on 100% and therefore cannot filter at all. READ THIS BEFORE ACTING ON IT: the gate has been FORWARD-TESTED and it does NOT improve outcomes. Triple-barrier labelling over 90 symbols with no lookahead, against a direction-matched baseline on the same bars: LONG signal 33.5% vs baseline 36.4% (-2.9 points, 198 independent events); SHORT 21.2% vs 28.9% (-7.7 points, 103 independent events). Four configurations were run and NONE favoured the gate. That is coherent rather than surprising: Stage 2 requires price above three rising stacked averages, which describes a move that ALREADY happened, and below ~21 days the documented effect is REVERSAL — see horizon_prior, and the Grimes result in mtf_analyze where a triple-MA trend read was INVERTED over ~903k equity observations. It is also only a CONSISTENCY filter: it opens on 25% of real symbols against 36% of random walks. Use it to describe alignment and to impose the universe restriction; do NOT read PARTICIPATE as evidence the trade beats an arbitrary one in the same direction. The chart is never switched — the loaded timeframe is the TRIGGER and the gate is built by aggregating it.',
    {
      count: z.coerce.number().optional().describe('Bars of the loaded timeframe to use (default 600 — the gate needs 50 aggregated bars)'),
      gate: z.string().optional().describe('How to build the gate timeframe from the loaded one: "week"/"month", or a bar multiple. Default "week". Shannon\'s swing row is a DAILY gate with a 30-minute trigger, so from a 30-minute chart pass 13 (13 half-hours = one session).'),
      side: z.enum(['long', 'short']).optional().describe('Restrict to one side. A side that contradicts the gate returns NO_SETUP rather than obliging.'),
      periods: z.string().optional().describe('Moving-average triple (default "10,20,50" — Shannon\'s daily set; his weekly set is 10,20,40 because 40 weeks is the 200-day equivalent)'),
      slope_lookback: z.coerce.number().optional().describe('Bars back to measure each average\'s slope (default 5). A one-bar slope is noise.'),
    },
    wrap(async ({ count = 600, gate = 'week', side = null, periods = null, slope_lookback = 5 }) => {
      const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
      if (!bars.length) throw new Error('No price bars came back from the chart.');

      const step = /^\d+$/.test(String(gate)) ? Number(gate) : String(gate);
      const agg = core.resampleBars(bars, step);
      const mas = parsePeriods(periods);

      // The aggregated newest bar is usually still forming. A stage read off a
      // partial bar is read off a price that has not finished happening.
      const gateBars = agg.partial_last_bar ? agg.bars.slice(0, -1) : agg.bars;

      const plan = stages.stagePlan({
        long_bars: gateBars,
        short_bars: bars,
        periods: mas,
        ...(side ? { side } : {}),
      });

      // A gate too short for the MA set is the commonest way to misuse this:
      // "week" assumes a DAILY chart, and on a 60-minute chart it collapses to a
      // handful of bars. Name the fix rather than returning a thin abstention.
      const needed = Math.max(...mas) + slope_lookback + 1;
      const gateHint = gateBars.length < needed
        ? {
            gate_too_short: `The ${gate} gate produced only ${gateBars.length} bars, and a ${Math.max(...mas)}-period `
              + `average needs ${needed}. Shannon's swing row is a DAILY gate with an intraday trigger, and "week" `
              + 'assumes the chart is already daily. From an intraday chart pass the bars-per-session multiple instead '
              + '(7 for 60-minute, 13 for 30-minute, 39 for 10-minute), or load more bars.',
          }
        : {};

      return {
        success: true,
        ...gateHint,
        gate_timeframe: typeof step === 'number' ? `loaded x${step}` : String(step),
        trigger_timeframe: 'loaded',
        trigger_bars: bars.length,
        gate_bars: gateBars.length,
        ...(agg.partial_warning ? { gate_partial_bar_dropped: agg.partial_warning } : {}),
        ...plan,
        // The action names a stop and a target location but computes neither.
        next_step: plan.action.action === 'PARTICIPATE'
          ? 'Size it with position_size_constrained (the risk budget alone is not the answer), place the initial stop '
            + 'beyond the most recent counter-trend pivot, and use pivot_trail to ratchet it. Check ta_trading_context '
            + 'for an earnings date first — Shannon holds nothing into a report.'
          : plan.action.action === 'ANTICIPATE'
            ? 'Set the alert a couple of pennies INSIDE the trigger level, not at it. levels_find gives the level; '
              + 'alert_create places it. Do not enter yet.'
            : plan.action.action === 'EXIT'
              ? 'Two triggers, and legs_classify reports both: the counter-trend pivot violated (a PRICE correction) or '
                + 'the short average crossing the intermediate one (a TIME correction).'
              : 'Nothing to do on this symbol right now.',
      };
    }),
  );

  server.tool(
    'stage_history',
    'THE OWNER\'S OWN FOUR-STATE CYCLE, run bar by bar: base / accumulation / distribution / declining. BASE is sideways — Bollinger-bandwidth PERCENTILE at or under 33. ACCUMULATION is their ENTRY signal — a buying volume spike (>= 1.5x) AND a breakout above the base\'s own high AND a positive 150-SMA slope. DISTRIBUTION is their EXIT signal — volume fading (recent mean < 0.8x the trailing 120-day mean) AND the 150-SMA flattening. DECLINING is a negative 150-SMA slope with a selling volume spike. Back to BASE on fading + flat + sideways. Returns the SEGMENTS (each state and how many bars it held), the TRANSITIONS between them, and the CURRENT segment with the date it began, for the loaded timeframe and for an aggregated gate series. THIS IS NOT stage_plan. stage_plan uses Shannon\'s classifyStage — price against three moving averages, no volume, pointwise — which is FROZEN and was forward-tested AS A GATE and FAILED: LONG signal 33.5% vs baseline 36.4% (-2.9 points, 198 independent events); SHORT 21.2% vs 28.9% (-7.7 points, 103 independent events), four configurations run and NONE favoured the gate. The two are different constructs and are CROSS-REFERENCED, never merged: classifyStage is read ONCE at the last bar into shannon_cross_reference so the readings can be compared, and where they disagree that is a fact about the chart. Each state also carries weinstein_equivalent (stage 1-4) — and note the vocabulary clash, because the owner\'s ACCUMULATION is the ADVANCE (Weinstein stage 2) where Wyckoff and Weinstein both use that word for the BASE. READ THE NOISE FLOOR BEFORE QUOTING A STATE: measured over 200 random walks at 600 bars with dispersed volume, ACCUMULATION — the entry signal — is reached by 43.0% of walks (52.5% with gap bars elevated). That is a HIGH floor. DISTRIBUTION is near zero (1.5-3.5%) but NOT because it is selective: its fading clause fires on 0.2-0.5% of noise bars at all. A cycle label is a DESCRIPTION of what price, volume and the 150-day average have already done; the entry signal belongs to the strategy (weinstein_stage_2), not to this detector, and the machine is UNTESTED at any horizon. Every threshold is an option with a named default — the owner\'s numbers are defaults, not settled.',
    {
      count: z.coerce.number().optional().describe('Bars of the loaded timeframe to classify (default 600 — the 150-period average plus the bandwidth percentile need a long warm-up)'),
      gate: z.string().optional().describe('How to build the aggregated gate series: "week"/"month", or a bar multiple. Default "week". The machine\'s windows are in bars OF THAT SERIES, so a 150-period average of weekly bars is ~3 years and the gate is usually empty — the cycle is meant to be read on the loaded series.'),
      base_pctile_max: z.coerce.number().optional().describe('OWNER: the sideways threshold, bandwidth percentile <= this (default 33)'),
      spike_mult: z.coerce.number().optional().describe('OWNER: volume spike multiple of the prior-bar average (default 1.5). BUYING when the bar closes up on the prior close, SELLING when down.'),
      fade_ratio: z.coerce.number().optional().describe('OWNER: recent volume mean below this multiple of the trailing mean counts as fading (default 0.8)'),
      sma_period: z.coerce.number().optional().describe('OWNER: the trend average (default 150 — the 30-week backbone in daily bars)'),
      fade_trailing_window: z.coerce.number().optional().describe('OWNER: the trailing volume window (default 120)'),
      pctile_window: z.coerce.number().optional().describe('OURS: bars the bandwidth is ranked against (default 252). The owner gave the threshold, not the lookback.'),
      spike_avg_window: z.coerce.number().optional().describe('OURS: bars in the spike baseline, excluding the current bar (default 20)'),
      fade_recent_window: z.coerce.number().optional().describe('OURS: the recent volume window (default 20)'),
      slope_lookback: z.coerce.number().optional().describe('OURS: bars back the SMA slope is measured over, as percent per bar (default 20)'),
      flat_slope_pct: z.coerce.number().optional().describe('HOUSE: |slope| below this percent per bar is FLAT (default 0.05 — the same number patterns.js uses for trendline and neckline flatness)'),
      allow_base_to_declining: z.coerce.boolean().optional().describe('OWNER-RULED, default TRUE (2026-07-31: a base that breaks down is either an exit or a short signal). Set false to restore the literal arrow list, dead end and all.'),
      distribution_requires_sideways: z.coerce.boolean().optional().describe('OWNER-RULED, default TRUE (the heartbeat reading: compression is part of DISTRIBUTION signature). Set false for the slope-only reading.'),
    },
    wrap(async ({ count = 600, gate = 'week', ...knobs }) => {
      const raw = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(raw);
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      return {
        success: true,
        // Stamped, and worth comparing to the symbol you asked for: a scan can move
        // the chart mid-analysis, and a read that cannot be attributed is not evidence.
        symbol: raw?.symbol ?? null,
        timeframe: raw?.resolution ?? null,
        ...stageHistory(bars, { gate, ...knobs }),
      };
    }),
  );

  server.tool(
    'stage_draw',
    'Draw the OWNER\'S CYCLE boundaries on the chart: one dashed vertical line per TRANSITION, labelled "cycle base>accumulation 2026-05-14", plus ONE callout for the current segment, "cycle accumulation since 2026-05-14 (34 bars)". Both label formats are REGISTERED in MCP_TEXT_SIGNATURES — a hand-drawn line with a hand-written label matches no signature and leaks an orphan that can never be swept up, because TradingView entity ids die with the desktop session and the text is the only handle left. Draws into group "stage-<TICKER>" and CLEARS THAT GROUP FIRST in both passes — clearAll for what the registry still tracks and an orphan sweep scoped to this tool\'s own signatures, so a walls overlay or the review\'s levels are never touched. Only ONE series is drawn at a time (default the loaded timeframe; pass series:"gate" for the aggregated one) because two sets of vertical lines through the same bars is overprinting. THESE ARE BOUNDARIES, NOT SIGNALS: each line marks the bar on which the owner\'s clauses changed state — volume, volatility and a 150-day average that have already moved — and the ENTRY belongs to the strategy (weinstein_stage_2), not to this detector. QUOTE THE NOISE FLOOR beside any ACCUMULATION line: measured over 200 random walks at 600 bars, the entry state is reached by 43.0% of walks on dispersed volume and 52.5% with gap bars elevated. The machine is UNTESTED at any horizon. It is also NOT stage_plan: that tool uses Shannon\'s frozen classifyStage, a different construct with no volume in it, which was forward-tested AS A GATE and FAILED — LONG signal 33.5% vs baseline 36.4% (-2.9 points, 198 independent events); SHORT 21.2% vs 28.9% (-7.7 points, 103 independent events), four configurations, NONE favoured the gate. stage_history carries that reading separately as a cross-reference.',
    {
      count: z.coerce.number().optional().describe('Bars of the loaded timeframe to classify (default 600)'),
      gate: z.string().optional().describe('How to build the aggregated gate series (default "week")'),
      series: z.enum(['trigger', 'gate']).optional().describe('Which history to draw: "trigger" is the loaded timeframe (default), "gate" the aggregated one. Never both — that is two sets of lines through the same bars.'),
      base_pctile_max: z.coerce.number().optional().describe('OWNER: the sideways threshold, bandwidth percentile <= this (default 33)'),
      spike_mult: z.coerce.number().optional().describe('OWNER: volume spike multiple (default 1.5)'),
      fade_ratio: z.coerce.number().optional().describe('OWNER: recent/trailing volume mean below this counts as fading (default 0.8)'),
      sma_period: z.coerce.number().optional().describe('OWNER: the trend average (default 150)'),
      allow_base_to_declining: z.coerce.boolean().optional().describe('OWNER-RULED, default TRUE: a base that breaks down is an exit or a short signal; false restores the literal arrow list'),
      max_transitions: z.coerce.number().optional().describe('Cap on the vertical lines drawn, most recent kept (default 12). A legibility bound, not an evidence one — everything over it comes back in `skipped`.'),
      draw_current: z.coerce.boolean().optional().describe('Also draw the current-segment callout (default true)'),
      group: z.string().optional().describe('Group name for clearing later (default "stage-<TICKER>")'),
    },
    wrap(async ({
      count = 600, gate = 'week', series = 'trigger',
      max_transitions = 12, draw_current = true, group = null, ...knobs
    }) => {
      const raw = await data.getOhlcv({ count, summary: false });
      const bars = normalizeBars(raw);
      if (!bars.length) throw new Error('No price bars came back from the chart.');
      const symbol = raw?.symbol ?? null;
      const timeframe = raw?.resolution ?? null;

      const history = stageHistory(bars, { gate, ...knobs });
      const plan = stageDrawPlan(history, {
        series,
        max_transitions,
        draw_current,
        price: bars.at(-1).close,
        last_bar_time: bars.at(-1).time,
        bar_seconds: barSecondsOf(bars),
        atr: atrFromBars(bars, 14),
      });

      if (!plan.shapes.length) {
        return {
          success: true, symbol, timeframe, drawn: 0, ...plan,
          note: 'Nothing to draw. No transition on this window is a real answer — a series that has held one '
            + 'state throughout has no boundary to mark. Read stage_history for the state it is in.',
        };
      }

      const groupName = group || `stage-${String(symbol || 'chart').replace(/^.*:/, '')}`;

      /**
       * CLEAR OUR OWN GROUP FIRST, IN BOTH PASSES.
       *
       * `clearAll` only removes what the registry still tracks, and TradingView
       * entity ids are SESSION-scoped — so anything drawn before the app last
       * restarted is invisible to it and would stack. The orphan pass catches
       * exactly those, and it is scoped to `sources: ['stage']` so it can only
       * ever claim this tool's own two label formats.
       */
      const cleared = { tracked: 0, orphaned: 0, group: groupName, sources: ['stage'] };
      try { cleared.tracked = (await drawing.clearAll({ scope: 'mcp', group: groupName }))?.removed || 0; }
      catch (e) { cleared.tracked_error = e.message; }
      try { cleared.orphaned = (await removeOrphans({ dry_run: false, sources: ['stage'] }))?.removed || 0; }
      catch (e) { cleared.orphaned_error = e.message; }

      const drawn = []; const failed = [];
      const put = async (fn, label) => {
        try {
          const r = await fn();
          if (r?.success || r?.entity_id) drawn.push({ shape: label, entity_id: r?.entity_id ?? null });
          else failed.push({ shape: label, why: 'created but could not be identified' });
        } catch (e) { failed.push({ shape: label, why: e.message }); }
      };
      await drawStageHistory(plan, groupName, put, drawing.drawShape);

      // Organize AFTER drawing, like drawFindings — an on-demand draw that
      // leaves a flat Object Tree is the gap the owner hit (2026-08-03).
      let native_groups = null;
      try {
        const vis = await import('../core/draw_visibility.js');
        native_groups = (await vis.organizeNativeGroups({})).groups ?? null;
      } catch (e) { native_groups = { error: e.message }; }

      return {
        success: failed.length === 0,
        symbol,
        timeframe,
        native_groups,
        group: groupName,
        cleared,
        drawn: drawn.length,
        shapes: drawn,
        ...plan,
        ...(failed.length ? { failed, warning: `${failed.length} shape(s) failed to draw.` } : {}),
        label_grammar: CYCLE_LABEL_GRAMMAR,
        clear_hint: `Remove with draw_clear group="${groupName}".`,
        current_reading: history.current || null,
        gate_reading: history.gate?.current || null,
      };
    }),
  );
}
