import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/drawing.js';
import * as vis from '../core/draw_visibility.js';

const timeField = z.union([z.number(), z.string()]).optional()
  .describe('Unix timestamp, "now", "last_bar", or an ISO date like "2026-07-26". Omit to use the last bar.');

export function registerDrawingTools(server) {
  server.tool('draw_shape', 'Draw a shape/line on the chart. Colors default to explicit, theme-visible values so labels are never invisible. Time is optional — omit it for price-only shapes like horizontal lines.', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
    point: z.object({
      price: z.coerce.number().describe('Price level'),
      time: timeField,
    }).describe('Primary point. Only price is required.'),
    point2: z.object({
      price: z.coerce.number(),
      time: timeField,
    }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    overrides: z.string().optional().describe('JSON string of style overrides, merged over the defaults (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Label text for the shape'),
    group: z.string().optional().describe('Tag this drawing so it can be cleared as a unit later via draw_clear'),
  }, async ({ shape, point, point2, overrides, text, group }) => {
    try { return jsonResult(await core.drawShape({ shape, point, point2, overrides, text, group })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_trade_plan', 'Draw a complete trade plan — entry, stop, targets with optional partial percentages, and optional break-even — as labelled, colour-coded, non-overlapping lines. Returns R:R per target and, if account_size and risk_percent are given, the implied position size. Validates that the levels agree with the direction. This draws and computes arithmetic on levels YOU supply; it is not trade advice and places no orders.', {
    direction: z.enum(['long', 'short']).describe('Trade direction'),
    entry: z.coerce.number().describe('Entry price'),
    stop: z.coerce.number().describe('Stop-loss price. Must be below entry for a long, above for a short.'),
    targets: z.array(z.union([
      z.coerce.number(),
      z.object({
        price: z.coerce.number(),
        label: z.string().optional().describe('Defaults to TP1, TP2, ...'),
        partial_pct: z.coerce.number().optional().describe('Percentage of the position to close here'),
      }),
    ])).optional().describe('Take-profit levels, as plain prices or objects with label/partial_pct'),
    breakeven: z.coerce.number().optional().describe('Optional break-even level, drawn as a dotted grey line'),
    account_size: z.coerce.number().optional().describe('Account size — supply with risk_percent to get position sizing'),
    risk_percent: z.coerce.number().optional().describe('Percent of account risked on this trade'),
    group: z.string().optional().describe('Group name for this plan (defaults to "<direction>-<entry>"). Use it with draw_clear to remove just this plan.'),
    label_prefix: z.string().optional().describe('Prefix for every label, e.g. a symbol name'),
    time: z.union([z.number(), z.string()]).optional().describe('Anchor time: unix timestamp, "now", "last_bar", or ISO date. Defaults to the last bar.'),
  }, async (args) => {
    try { return jsonResult(await core.drawTradePlan(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_list', 'List drawings on the chart. Each entry is flagged with created_by_mcp and its group, so you can tell your own drawings from the user\'s. Pass include_points to get each drawing\'s price/time coordinates in the same call — use this to read a trade the user drew by hand.', {
    include_points: z.coerce.boolean().optional().describe('Include price/time points for every drawing (default false)'),
  }, async ({ include_points } = {}) => {
    try { return jsonResult(await core.listDrawings({ include_points })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_clear', 'Remove drawings. Defaults to scope "mcp", which removes ONLY drawings this tool created and leaves the user\'s own drawings untouched. Pass scope "all" to wipe every drawing on the chart — that is not reversible, so confirm with the user first. Pass a group to remove just one trade plan.', {
    scope: z.enum(['mcp', 'all']).optional().describe('"mcp" (default) = only drawings created by this tool. "all" = every drawing on the chart, including the user\'s own.'),
    group: z.string().optional().describe('Only remove drawings in this group (scope "mcp" only)'),
  }, async ({ scope, group } = {}) => {
    try { return jsonResult(await core.clearAll({ scope, group })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_list_groups', 'List the drawing groups this tool has created, so you can clear or reference a specific trade plan.', {}, async () => {
    try { return jsonResult(core.listGroups()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.removeOne({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getProperties({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_toggle', 'Hide or show MCP drawings WITHOUT deleting them — by category (levels, patterns, plans, zones, cycle, earnings, fib, elliott, walls...), by registry group, or by explicit entity ids. Omit every selector to get the census: what is on the chart, by category, with visible/hidden counts. Every write is READ BACK from the entity before it is counted as changed — setProperties has a history of silent no-ops here. Foreign (hand-drawn) shapes are reported in the census but never touched by a category toggle.', {
    category: z.string().optional().describe('One census category, e.g. "levels", "patterns", "cycle". See the census output for what is on this chart.'),
    group: z.string().optional().describe('A registry group, e.g. "analysis-AMD" — tracked shapes only'),
    entity_ids: z.array(z.string()).optional().describe('Explicit entity ids from draw_list / the census'),
    visible: z.coerce.boolean().optional().describe('true = show, false = hide. Required with any selector; ignored for the bare census call.'),
  }, async ({ category, group, entity_ids, visible } = {}) => {
    try {
      if (category == null && group == null && entity_ids == null) {
        const c = await vis.visibilityCensus();
        // the per-shape rows are census detail; the categories are the answer
        return jsonResult({ success: true, count: c.count, categories: c.categories });
      }
      if (typeof visible !== 'boolean') {
        return jsonResult({ success: false, error: 'visible (true/false) is required when toggling.' }, true);
      }
      return jsonResult(await vis.toggleDrawings({ category, group, entity_ids, visible }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('draw_organize', 'Organize MCP drawings into NATIVE TradingView groups — one row per category ("MCP levels", "MCP patterns", "MCP cycle"...) in the chart\'s Object Tree panel, each with its own eye icon, so the user can hide/show a whole category with one click and no MCP call. mode "group" creates/refreshes them (re-running after a redraw regroups the new shapes), "dissolve" removes the group rows while LEAVING every drawing on the chart, "status" lists ours with visibility. Never call the raw removeGroup API: it deletes the member drawings — dissolve here excludes members first, which is the probed-safe path.', {
    mode: z.enum(['group', 'dissolve', 'status']).optional().describe('Default "group"'),
  }, async ({ mode = 'group' } = {}) => {
    try {
      if (mode === 'dissolve') return jsonResult(await vis.dissolveNativeGroups({}));
      if (mode === 'status') return jsonResult(await vis.nativeGroupStatus({}));
      return jsonResult(await vis.organizeNativeGroups({}));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
