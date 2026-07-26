import { register } from '../router.js';
import * as core from '../../core/doctor.js';
import * as rules from '../../core/rules.js';

register('doctor', {
  description: 'Run every setup check at once (node, TradingView, CDP, server, rules)',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'skip-server-test': { type: 'boolean', description: 'Skip the MCP server smoke test' },
  },
  handler: (opts) => core.doctor({
    port: opts.port ? Number(opts.port) : 9222,
    skip_server_test: !!opts['skip-server-test'],
  }),
});

register('rules', {
  description: 'Inspect or create your rules.json',
  subcommands: new Map([
    ['init', {
      description: 'Create rules.json from rules.example.json',
      options: {
        path: { type: 'string', description: 'Write to a specific path' },
        force: { type: 'boolean', description: 'Overwrite an existing rules.json' },
      },
      handler: ({ path, force }) => rules.initRules({ path, force: !!force }),
    }],
    ['path', {
      description: 'Show which rules.json would be used',
      handler: () => rules.rulesStatus(),
    }],
  ]),
});
