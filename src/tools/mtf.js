import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/mtf.js';
import * as data from '../core/data.js';
import { normalizeBars, findSwings, alternateSwings, classifyStructure } from '../core/structure.js';
import { regime } from '../core/context.js';

const wrap = (fn) => async (args = {}) => {
  try { return jsonResult(await fn(args)); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
};

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
}
