import { register } from '../router.js';
import * as core from '../../core/chart.js';
import * as healthCore from '../../core/health.js';

register('state', {
  description: 'Get current chart state (symbol, TF, studies)',
  handler: () => core.getState(),
});

// `symbol`, `timeframe` and `type` each used to take a bare positional and
// treat it as "set this". That made every mistyped or misremembered subcommand
// a chart mutation: `tv symbol info` set the chart to BATS:INFO — a real ETF —
// and reported success, and everything downstream then analysed the wrong
// instrument. Mutating now requires the explicit `set` verb, and anything not
// in the subcommand map is an error rather than a ticker.
register('symbol', {
  description: 'Symbol tools (get, set, info, search)',
  defaultSubcommand: 'get',
  subcommands: new Map([
    ['get', {
      description: 'Show the current chart symbol',
      handler: async () => {
        const state = await core.getState();
        return { success: true, symbol: state.symbol, resolution: state.resolution };
      },
    }],
    ['set', {
      description: 'Change the chart symbol — tv symbol set CSCO',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv symbol set CSCO');
        if (positionals.length > 1) {
          throw new Error(`Expected one symbol, got ${positionals.length}: ${positionals.join(' ')}. Usage: tv symbol set CSCO`);
        }
        return core.setSymbol({ symbol: positionals[0] });
      },
    }],
    ['info', {
      description: 'Detailed metadata for the current symbol (MCP: symbol_info)',
      handler: () => core.symbolInfo(),
    }],
    ['search', {
      description: 'Search for symbols by name or keyword (MCP: symbol_search)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Query required. Usage: tv symbol search AAPL');
        return core.symbolSearch({ query: positionals.join(' ') });
      },
    }],
  ]),
});

register('timeframe', {
  description: 'Timeframe tools (get, set)',
  defaultSubcommand: 'get',
  subcommands: new Map([
    ['get', {
      description: 'Show the current chart timeframe',
      handler: async () => {
        const state = await core.getState();
        return { success: true, resolution: state.resolution, symbol: state.symbol };
      },
    }],
    ['set', {
      description: 'Change the chart timeframe — tv timeframe set 60',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Timeframe required. Usage: tv timeframe set 60');
        if (positionals.length > 1) {
          throw new Error(`Expected one timeframe, got ${positionals.length}: ${positionals.join(' ')}. Usage: tv timeframe set 60`);
        }
        return core.setTimeframe({ timeframe: positionals[0] });
      },
    }],
  ]),
});

const CHART_TYPE_NAMES = ['Bars', 'Candles', 'Line', 'Area', 'Renko', 'Kagi', 'PointAndFigure', 'LineBreak', 'HeikinAshi', 'HollowCandles'];

register('type', {
  description: 'Chart type tools (get, set)',
  defaultSubcommand: 'get',
  subcommands: new Map([
    ['get', {
      description: 'Show the current chart type',
      handler: async () => {
        const state = await core.getState();
        return { success: true, chart_type: CHART_TYPE_NAMES[state.chartType] || state.chartType, type_num: state.chartType };
      },
    }],
    ['set', {
      description: 'Change the chart type — tv type set Candles',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error(`Chart type required. Usage: tv type set Candles. One of: ${CHART_TYPE_NAMES.join(', ')}`);
        return core.setType({ chart_type: positionals[0] });
      },
    }],
  ]),
});

// Read-only aliases for `tv symbol info` / `tv symbol search`, kept because
// they were the original spelling. Both only read.
register('info', {
  description: 'Get detailed symbol metadata (alias for "tv symbol info")',
  handler: () => core.symbolInfo(),
});

register('search', {
  description: 'Search for symbols by name or keyword (alias for "tv symbol search")',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Query required. Usage: tv search AAPL');
    return core.symbolSearch({ query: positionals.join(' ') });
  },
});

register('range', {
  description: 'Get or set the visible chart range',
  options: {
    from: { type: 'string', description: 'Start timestamp (unix seconds)' },
    to: { type: 'string', description: 'End timestamp (unix seconds)' },
  },
  handler: async (opts) => {
    if (opts.from && opts.to) return core.setVisibleRange({ from: Number(opts.from), to: Number(opts.to) });
    return core.getVisibleRange();
  },
});

register('scroll', {
  description: 'Scroll the chart to a specific date',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Date required. Usage: tv scroll 2025-01-15');
    return core.scrollToDate({ date: positionals[0] });
  },
});

register('discover', {
  description: 'Report which TradingView API paths are available',
  handler: () => healthCore.discover(),
});

register('ui-state', {
  description: 'Get current UI state (panels, buttons)',
  handler: () => healthCore.uiState(),
});
