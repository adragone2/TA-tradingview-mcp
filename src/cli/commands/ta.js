import { register } from '../router.js';
import * as core from '../../core/ta_api.js';

register('ta', {
  description: 'Tactical Alpha API — portfolio, earnings, regime (investing context for trading decisions)',
  subcommands: new Map([
    ['health', {
      description: 'Check the TA API is reachable and a key is configured',
      handler: () => core.health(),
    }],
    ['status', {
      description: 'Show the TA base URL and whether a key is configured (never the key)',
      handler: () => core.apiStatus(),
    }],
    ['context', {
      description: 'Position + catalyst + regime context for tickers',
      options: {
        symbols: { type: 'string', short: 's', description: 'Comma-separated tickers' },
      },
      handler: ({ symbols }) => {
        if (!symbols) throw new Error('--symbols is required, e.g. --symbols AMD,AVGO');
        return core.tradingContext({ symbols: symbols.split(',').map((s) => s.trim()).filter(Boolean) });
      },
    }],
    ['portfolio', {
      description: 'Current portfolio positions',
      options: { live: { type: 'boolean', description: 'Use live marks' } },
      handler: ({ live }) => core.portfolio({ live: !!live }),
    }],
    ['earnings', {
      description: 'TA earnings calendar',
      handler: () => core.earnings(),
    }],
    ['regime', {
      description: 'Market regime',
      options: { detail: { type: 'string', description: 'regime|vol|vix|macro|sectors|breadth' } },
      handler: ({ detail }) => {
        switch (detail) {
          case 'vol': return core.volRegime();
          case 'vix': return core.vix();
          case 'macro': return core.macro();
          case 'sectors': return core.sectors();
          case 'breadth': return core.breadth();
          default: return core.regime();
        }
      },
    }],
    ['alerts', { description: 'Active TA alerts', handler: () => core.alerts() }],
    ['brief', { description: "TA's investing morning brief", handler: () => core.investingBrief() }],
    ['get', {
      description: 'GET any TA endpoint, e.g. tv ta get /api/v1/etf/SPY/holdings',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Provide a path, e.g. /api/health');
        return core.get(positionals[0]);
      },
    }],
  ]),
});
