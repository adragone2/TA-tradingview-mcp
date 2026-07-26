import { register } from '../router.js';
import * as core from '../../core/drawing.js';

function parseTargets(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  // Accept either JSON (for labels/partials) or a plain comma-separated list.
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`--targets is not valid JSON: ${e.message}`);
    }
  }
  return trimmed.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isFinite(n)) throw new Error(`--targets contains a non-number: "${s.trim()}"`);
    return n;
  });
}

register('draw', {
  description: 'Drawing tools (shape, plan, list, groups, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, trend_line, rectangle, text' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp, "now", "last_bar", or ISO date (default: last bar)' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time' },
        text: { type: 'string', description: 'Label text' },
        overrides: { type: 'string', description: 'JSON style overrides' },
        group: { type: 'string', short: 'g', description: 'Group tag for later clearing' },
      },
      handler: (opts) => {
        if (opts.price === undefined) throw new Error('--price is required');
        const point = { price: Number(opts.price), time: opts.time };
        const point2 = opts.price2 ? { price: Number(opts.price2), time: opts.time2 } : undefined;
        return core.drawShape({
          shape: opts.type || 'horizontal_line',
          point, point2,
          overrides: opts.overrides,
          text: opts.text,
          group: opts.group,
        });
      },
    }],
    ['plan', {
      description: 'Draw a full trade plan (entry, stop, targets, break-even) with R:R',
      options: {
        direction: { type: 'string', short: 'd', description: 'long or short' },
        entry: { type: 'string', short: 'e', description: 'Entry price' },
        stop: { type: 'string', short: 's', description: 'Stop-loss price' },
        targets: { type: 'string', description: 'Comma-separated prices, or a JSON array for labels/partials' },
        breakeven: { type: 'string', description: 'Break-even price' },
        account: { type: 'string', description: 'Account size (with --risk gives position sizing)' },
        risk: { type: 'string', description: 'Percent of account risked' },
        group: { type: 'string', short: 'g', description: 'Group name for this plan' },
        prefix: { type: 'string', description: 'Label prefix' },
        time: { type: 'string', description: 'Anchor time (default: last bar)' },
      },
      handler: (opts) => {
        if (!opts.direction) throw new Error('--direction is required (long or short)');
        if (opts.entry === undefined) throw new Error('--entry is required');
        if (opts.stop === undefined) throw new Error('--stop is required');
        return core.drawTradePlan({
          direction: opts.direction,
          entry: Number(opts.entry),
          stop: Number(opts.stop),
          targets: parseTargets(opts.targets),
          breakeven: opts.breakeven === undefined ? undefined : Number(opts.breakeven),
          account_size: opts.account === undefined ? undefined : Number(opts.account),
          risk_percent: opts.risk === undefined ? undefined : Number(opts.risk),
          group: opts.group,
          label_prefix: opts.prefix,
          time: opts.time,
        });
      },
    }],
    ['list', {
      description: 'List drawings, flagged by whether this tool created them',
      options: {
        points: { type: 'boolean', description: 'Include price/time points for each drawing' },
      },
      handler: (opts) => core.listDrawings({ include_points: !!opts.points }),
    }],
    ['groups', {
      description: 'List drawing groups created by this tool',
      handler: () => core.listGroups(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (opts, positionals) => core.getProperties({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (opts, positionals) => core.removeOne({ entity_id: positionals[0] }),
    }],
    ['clear', {
      description: 'Remove drawings created by this tool (--scope all wipes everything)',
      options: {
        scope: { type: 'string', description: '"mcp" (default) or "all"' },
        group: { type: 'string', short: 'g', description: 'Only clear this group' },
      },
      handler: (opts) => core.clearAll({ scope: opts.scope || 'mcp', group: opts.group }),
    }],
  ]),
});
