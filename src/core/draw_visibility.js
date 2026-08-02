/**
 * Toggle MCP drawings on and off — per shape, per category, or through
 * TradingView's own Object Tree via NATIVE drawing groups.
 *
 * Everything here rides on four live probes (2026-08-02, BATS:AMD):
 *
 * 1. Every line tool carries a `visible` property and `setProperties({visible})`
 *    ROUND-TRIPS — set false, read back false, shape hides. That matters because
 *    setProperties has a documented silent-failure history in this repo (text on
 *    multipoint creates), so every write here is read back before it is believed.
 *
 * 2. `shapesGroupController()` is TradingView's native grouping — the thing that
 *    gives a drawing group ONE row with an eye icon in the Object Tree panel.
 *    The whole chain is scriptable: selection().set(ids) →
 *    createGroupFromSelection() → setGroupName → setGroupVisibility. A group
 *    toggle propagates to the members' own `visible` property (verified), and
 *    groups PERSIST across a symbol round-trip when the shapes went through the
 *    production drawShape path.
 *
 * 3. ── THE TRAP ── `removeGroup(gid)` DELETES THE MEMBER DRAWINGS. It is not a
 *    dissolve. Measured live: two vertical lines gone with their group. The safe
 *    dissolve is excludeShapeFromGroup per member — the group auto-removes when
 *    its last member is excluded, and shapes survive (verified, 2/2 alive).
 *    Nothing in this module calls removeGroup while a group still has members.
 *
 * 4. Deleting all member shapes (draw_clear's path) auto-removes the group too,
 *    so a weekly redraw leaves no ghost groups behind.
 *
 * Categories are a SECOND layer over ownership, not a replacement for it.
 * `orphans.js` signatures answer "is this ours?" — exact, anchored, append-only,
 * because a false claim deletes a hand-drawn shape. Categories answer "which
 * kind of ours?" over text already known (or registry-tracked) to be ours, so
 * coarse prefixes are enough and deliberately DON'T duplicate the signature
 * grammar — two copies of those regexes would drift, and the drift would be
 * silent. A fixture test walks real labels from every emitter family through
 * both layers to keep this one honest.
 *
 * The five TEXTLESS native shapes (text does not survive a multipoint create —
 * see drawing.js) classify by SHAPE NAME instead, and only while the registry
 * still tracks them: after a TradingView restart their registry entries die
 * with the session ids, and an untracked textless channel is indistinguishable
 * from a hand-drawn one. Those read `foreign`, which is correct — a toggle
 * must not claim what it cannot attribute.
 */

import { evaluate, getChartApi } from '../connection.js';
import * as registry from './drawing_registry.js';
import { isMcpText } from './orphans.js';

/** Native-group display names use this prefix; dissolve targets it too. */
export const NATIVE_GROUP_PREFIX = 'MCP ';

/**
 * Category rules over MCP-owned label text, first match wins. Coarse on
 * purpose (see module comment). Order matters: plan legs mention pattern
 * names ("ENTRY long 30.77 — double_bottom"), so plans test before patterns.
 */
export const CATEGORY_RULES = [
  { category: 'plans', test: (t) => /^(?:ENTRY|STOP|TARGET|TA stop) /.test(t) },
  { category: 'levels', test: (t) => /^[SR] \d/.test(t) || /^VCP pivot \d/.test(t) },
  { category: 'zones', test: (t) => /^(?:demand|supply)\b/.test(t) },
  { category: 'cycle', test: (t) => /^cycle /.test(t) },
  { category: 'earnings', test: (t) => /^earnings \d{4}-/.test(t) },
  // ta_decision before walls: "TA Call Wall 143.24" contains the walls vocabulary
  { category: 'ta_decision', test: (t) => /^TA (?:Call|Put|BB|PIF|Stop)/.test(t) },
  { category: 'walls', test: (t) => /(?:Call Wall|Put Wall|Call GEX|Put GEX|Gamma Flip)/.test(t) },
  // everything else the review emits is pattern geometry: "<pattern> forming",
  // "... — completes 34.2", "... upper", "... target 19.32"
  { category: 'patterns', test: (t) => / (?:forming|confirmed)\b| (?:upper|lower)$/.test(t) },
];

/** Textless natives, attributable only while the registry tracks them. */
export const TEXTLESS_SHAPE_CATEGORIES = {
  fib_retracement: 'fib',
  parallel_channel: 'patterns',
  elliott_impulse_wave: 'elliott',
  fixed_range_volume_profile: 'volume_profile',
  long_position: 'plans',
  short_position: 'plans',
};

/**
 * Classify one shape. Pure.
 *
 * `created_by_mcp` is the registry's word, and it gates the shape-name rules:
 * text can vouch for itself through the signatures, a bare shape name cannot.
 */
export function classifyShape({ name = '', text = '', created_by_mcp = false } = {}) {
  const t = String(text || '').trim();
  if (t && isMcpText(t)) {
    for (const rule of CATEGORY_RULES) if (rule.test(t)) return rule.category;
    return 'other_mcp'; // signed but unrecognised — a NEW label family; add a rule
  }
  if (created_by_mcp) return TEXTLESS_SHAPE_CATEGORIES[name] ?? 'other_mcp';
  return 'foreign';
}

/**
 * One page-side pass: every shape with its text and visibility. One CDP round
 * trip regardless of shape count — 27 getProperties calls from Node would be
 * 27 round trips.
 */
async function readShapes() {
  const apiPath = await getChartApi();
  const rows = await evaluate(`(function(){
    var api = ${apiPath};
    return api.getAllShapes().map(function(s){
      var text = '', visible = null;
      try {
        var p = api.getShapeById(s.id).getProperties();
        text = p.text || '';
        visible = p.visible !== undefined ? !!p.visible : null;
      } catch(e) {}
      return { id: s.id, name: s.name, text: text, visible: visible };
    });
  })()`);
  const tracked = new Map(registry.list().map((e) => [e.entity_id, e]));
  return (rows || []).map((s) => {
    const t = tracked.get(s.id);
    return { ...s, created_by_mcp: !!t, group: t?.group ?? null };
  });
}

/**
 * The census: what is on the chart, by category, with visibility counts.
 * `foreign` is reported but never targeted by a category toggle.
 */
export async function visibilityCensus() {
  const shapes = await readShapes();
  const categories = {};
  for (const s of shapes) {
    const cat = classifyShape(s);
    const c = (categories[cat] ??= { total: 0, visible: 0, hidden: 0, ids: [] });
    c.total += 1;
    if (s.visible === false) c.hidden += 1; else c.visible += 1;
    c.ids.push(s.id);
  }
  return { success: true, count: shapes.length, categories, shapes };
}

/**
 * Set visibility on explicit ids, page-side in one pass, READ BACK per id.
 * A write that does not read back is reported as unverified, not as done —
 * setProperties failing silently is this repo's oldest enemy.
 */
export async function setVisibility({ entity_ids, visible }) {
  if (!Array.isArray(entity_ids) || entity_ids.length === 0) {
    return { success: true, changed: 0, results: [] };
  }
  if (typeof visible !== 'boolean') throw new Error('visible must be true or false.');
  const apiPath = await getChartApi();
  const results = await evaluate(`(function(){
    var api = ${apiPath};
    return ${JSON.stringify(entity_ids)}.map(function(id){
      try {
        var sh = api.getShapeById(id);
        sh.setProperties({ visible: ${visible} });
        var back = sh.getProperties().visible;
        return { id: id, verified: back === ${visible}, visible: back };
      } catch(e) { return { id: id, verified: false, error: e.message }; }
    });
  })()`);
  const rows = results || [];
  return {
    success: true,
    requested: entity_ids.length,
    changed: rows.filter((r) => r.verified).length,
    unverified: rows.filter((r) => !r.verified),
    results: rows,
  };
}

/**
 * Toggle by category, registry group, or explicit ids — exactly one selector.
 *
 * Category and group toggles touch only MCP-attributable shapes. Explicit
 * `entity_ids` are taken as given (the caller read them off a census and may
 * legitimately point at a foreign shape they recognise as their own).
 */
export async function toggleDrawings({ category = null, group = null, entity_ids = null, visible }) {
  const selectors = [category, group, entity_ids].filter((x) => x != null).length;
  if (selectors !== 1) {
    throw new Error('Pass exactly one of category, group, or entity_ids.');
  }
  let ids = entity_ids;
  let census = null;
  if (!ids) {
    census = await visibilityCensus();
    if (category) {
      const c = census.categories[category];
      if (!c) {
        const have = Object.keys(census.categories).filter((k) => k !== 'foreign');
        return {
          success: true, changed: 0,
          why: `no shapes in category "${category}" — on this chart: ${have.join(', ') || 'none'}`,
        };
      }
      ids = c.ids;
    } else {
      ids = census.shapes.filter((s) => s.created_by_mcp && s.group === group).map((s) => s.id);
      if (!ids.length) {
        return { success: true, changed: 0, why: `no tracked shapes in group "${group}"` };
      }
    }
  }
  const r = await setVisibility({ entity_ids: ids, visible });
  return { ...r, category: category ?? undefined, group: group ?? undefined };
}

/**
 * Plan native groups from a census. Pure — the executor draws no conclusions.
 * One native group per category that has ≥1 attributable shape; `foreign`
 * never gets grouped (grouping is a claim of ownership in the user's own UI).
 */
export function organizePlan(census, { prefix = NATIVE_GROUP_PREFIX } = {}) {
  const groups = [];
  for (const [cat, c] of Object.entries(census.categories || {})) {
    if (cat === 'foreign' || !c.ids?.length) continue;
    groups.push({ name: `${prefix}${cat}`, category: cat, ids: c.ids });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

/**
 * Create/refresh the native groups for the current chart.
 *
 * Existing groups with the same name are DISSOLVED first (exclude-members —
 * never removeGroup, see the trap in the module comment) so a re-run after a
 * redraw regroups the new entity ids instead of stacking a second group with
 * the same display name.
 */
export async function organizeNativeGroups({ prefix = NATIVE_GROUP_PREFIX } = {}) {
  const census = await visibilityCensus();
  const plan = organizePlan(census, { prefix });
  if (!plan.length) {
    return { success: true, groups: [], why: 'no MCP shapes on this chart to organize' };
  }
  const apiPath = await getChartApi();
  const result = await evaluate(`(function(){
    var api = ${apiPath};
    var gc = api.shapesGroupController();
    var plan = ${JSON.stringify(plan)};
    // dissolve any prior group with a planned name — exclude members, NEVER removeGroup
    var planned = {};
    plan.forEach(function(p){ planned[p.name] = true; });
    gc.groups().slice().forEach(function(g){
      var gid = g.id || g, name = '';
      try { name = gc.getGroupName(gid); } catch(e) { return; }
      if (!planned[name]) return;
      var members = [];
      try { members = gc.shapesInGroup(gid).slice(); } catch(e) {}
      members.forEach(function(id){ try { gc.excludeShapeFromGroup(gid, id); } catch(e) {} });
      // group auto-removes on last exclusion (probed); a lingering empty is removed
      try {
        var still = gc.groups().some(function(x){ return (x.id || x) === gid; });
        if (still && gc.shapesInGroup(gid).length === 0) gc.removeGroup(gid);
      } catch(e) {}
    });
    return plan.map(function(p){
      try {
        api.selection().set(p.ids);
        var gid = gc.createGroupFromSelection();
        api.selection().clear();
        gc.setGroupName(gid, p.name);
        return { name: p.name, category: p.category,
                 members: gc.shapesInGroup(gid).length,
                 name_readback: gc.getGroupName(gid) };
      } catch(e) {
        try { api.selection().clear(); } catch(e2) {}
        return { name: p.name, category: p.category, error: e.message };
      }
    });
  })()`);
  const rows = result || [];
  return {
    success: true,
    groups: rows,
    note: 'Each group is one row in TradingView\'s Object Tree — the eye icon hides/shows the whole category.',
  };
}

/**
 * Dissolve our native groups (shapes stay). The inverse of organize, for when
 * the Object Tree rows are in the way. NEVER removeGroup with members in it.
 */
export async function dissolveNativeGroups({ prefix = NATIVE_GROUP_PREFIX } = {}) {
  const apiPath = await getChartApi();
  const result = await evaluate(`(function(){
    var api = ${apiPath};
    var gc = api.shapesGroupController();
    var out = [];
    gc.groups().slice().forEach(function(g){
      var gid = g.id || g, name = '';
      try { name = gc.getGroupName(gid); } catch(e) { return; }
      if (name.indexOf(${JSON.stringify(prefix)}) !== 0) return;
      var members = [];
      try { members = gc.shapesInGroup(gid).slice(); } catch(e) {}
      var alive = 0;
      members.forEach(function(id){ try { gc.excludeShapeFromGroup(gid, id); } catch(e) {} });
      members.forEach(function(id){ try { api.getShapeById(id); alive++; } catch(e) {} });
      try {
        var still = gc.groups().some(function(x){ return (x.id || x) === gid; });
        if (still && gc.shapesInGroup(gid).length === 0) gc.removeGroup(gid);
      } catch(e) {}
      out.push({ name: name, members: members.length, shapes_alive_after: alive });
    });
    return out;
  })()`);
  const rows = result || [];
  const lost = rows.filter((r) => r.shapes_alive_after < r.members);
  return {
    success: true,
    dissolved: rows,
    ...(lost.length ? { WARNING: 'members died during dissolve — should be impossible, investigate', lost } : {}),
  };
}

/** Current native groups whose name carries our prefix, with visibility. */
export async function nativeGroupStatus({ prefix = NATIVE_GROUP_PREFIX } = {}) {
  const apiPath = await getChartApi();
  const rows = await evaluate(`(function(){
    var api = ${apiPath};
    var gc = api.shapesGroupController();
    return gc.groups().map(function(g){
      var gid = g.id || g;
      var name = '', vis = null, members = null;
      try { name = gc.getGroupName(gid); } catch(e) {}
      try { vis = String(gc.groupVisibility(gid)); } catch(e) {}
      try { members = gc.shapesInGroup(gid).length; } catch(e) {}
      return { id: String(gid), name: name, visibility: vis, members: members };
    }).filter(function(r){ return r.name.indexOf(${JSON.stringify(prefix)}) === 0; });
  })()`);
  return { success: true, groups: rows || [] };
}
