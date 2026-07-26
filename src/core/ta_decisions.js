/**
 * TA entry and exit decisions, rendered on the chart.
 *
 * TA computes complete trade plans — entry levels with a put wall and stop, exit
 * levels with a stop, call wall and resistance — and until now they lived in a
 * CSV nobody could see while looking at a chart. These tools pull the row for a
 * symbol and draw its levels.
 *
 * This is TA's output, not a recommendation generated here. The levels, the
 * urgency and the sizing are all TA's; this module transports and draws them.
 */
import * as ta from './ta_api.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

/**
 * Parse a CSV whose fields may be quoted and contain commas — TA's Reasoning
 * and Catalysts columns both do, so a naive split corrupts every later column.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function loadDataset(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const res = await ta.get(`/api/v1/sync/${name}`, { raw: true, timeoutMs: 90000 });
  const text = res.text || '';
  if (!text) throw new Error(`${name} came back empty from TA.`);

  const value = {
    rows: parseCsv(text),
    age_hours: res.freshness?.age_hours ?? null,
    generated_at: res.freshness?.generated_at ?? null,
  };
  cache.set(name, { at: Date.now(), value });
  return value;
}

function freshnessWarnings(ds, label) {
  const w = [];
  if (Number.isFinite(ds.age_hours)) {
    if (ds.age_hours > 30) {
      w.push(`${label} are ${Math.round(ds.age_hours)}h old. TA refreshes these on its EOD pipeline — past ~30h on a trading day the run did not happen, and the levels describe stale conditions.`);
    }
  } else {
    w.push(`TA did not report a freshness header for ${label}, so their age is unknown.`);
  }
  return w;
}

const bare = (s) => String(s || '').toUpperCase().replace(/^.*:/, '').trim();

/** TA's entry decision for a symbol, with its levels extracted. */
export async function entryFor({ symbol } = {}) {
  const t = bare(symbol);
  if (!t) throw new Error('symbol is required.');
  const ds = await loadDataset('entry_decisions');
  const row = ds.rows.find((r) => bare(r.Ticker) === t);
  if (!row) {
    throw new Error(`No TA entry decision for ${t}. TA has ${ds.rows.length} entry rows; the symbol may not be a current candidate.`);
  }

  return {
    success: true,
    ticker: t,
    as_of: ds.generated_at,
    age_hours: ds.age_hours,
    action: row.Action || null,
    entry_type: row.Entry_Type || null,
    conviction: row.Conviction_Tier || null,
    tranche: row.Tranche_Size || null,
    suggested_usd: num(row.Suggested_USD),
    suggested_shares: num(row.Suggested_Shares),
    score: num(row.Composite_Entry_Score),
    levels: {
      current_price: num(row.Current_Price),
      put_wall: num(row.Put_Wall),
      bb_lower: num(row.BB_Lower),
      pif_support: num(row.PIF_Support),
      to_stop_pct: num(row.To_Stop),
    },
    catalysts: row.Catalysts || null,
    ...(freshnessWarnings(ds, 'Entry decisions').length ? { warnings: freshnessWarnings(ds, 'Entry decisions') } : {}),
    note: "TA's own entry decision. Sizing and conviction are TA's; this tool transports and draws them.",
  };
}

/** TA's exit decision for a symbol, with its levels extracted. */
export async function exitFor({ symbol } = {}) {
  const t = bare(symbol);
  if (!t) throw new Error('symbol is required.');
  const ds = await loadDataset('exit_decisions');
  const row = ds.rows.find((r) => bare(r.Ticker) === t);
  if (!row) {
    throw new Error(`No TA exit decision for ${t}. Exit decisions only exist for held positions — TA has ${ds.rows.length} rows.`);
  }

  return {
    success: true,
    ticker: t,
    as_of: ds.generated_at,
    age_hours: ds.age_hours,
    action: row.Action || null,
    exit_type: row.Exit_Type || null,
    urgency: row.Urgency || null,
    layer: row.Layer || null,
    exit_pct: num(row.Exit_Pct),
    days_held: num(row.Days_Held),
    total_return_pct: num(row.Total_Return_Pct),
    levels: {
      current_price: num(row.Current_Price),
      stop_price: num(row.Stop_Price),
      call_wall: num(row.Call_Wall),
      bb_upper: num(row.BB_Upper),
      pif_resistance: num(row.PIF_Resistance),
    },
    reasoning: row.Reasoning || null,
    reason_code: row.Exit_Reason_Code || null,
    ...(freshnessWarnings(ds, 'Exit decisions').length ? { warnings: freshnessWarnings(ds, 'Exit decisions') } : {}),
    note: "TA's own exit decision. Urgency and levels are TA's; this tool transports and draws them.",
  };
}

/**
 * Everything TA currently flags as actionable, most urgent first.
 * Answers "what needs attention" without loading a symbol at a time.
 */
export async function actionable({ limit = 25 } = {}) {
  const [entries, exits] = await Promise.all([
    loadDataset('entry_decisions').catch((e) => ({ rows: [], error: e.message })),
    loadDataset('exit_decisions').catch((e) => ({ rows: [], error: e.message })),
  ]);

  const URGENCY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  const exitRows = exits.rows
    .filter((r) => r.Action && !/^(HOLD|NONE|NO_ACTION)$/i.test(r.Action))
    .sort((a, b) => (URGENCY[a.Urgency] ?? 9) - (URGENCY[b.Urgency] ?? 9))
    .slice(0, limit)
    .map((r) => ({
      ticker: bare(r.Ticker), side: 'exit', action: r.Action, urgency: r.Urgency,
      exit_pct: num(r.Exit_Pct), price: num(r.Current_Price), stop: num(r.Stop_Price),
      return_pct: num(r.Total_Return_Pct), reason: (r.Reasoning || '').slice(0, 120),
    }));

  const entryRows = entries.rows
    .filter((r) => /BUY/i.test(r.Action || ''))
    .sort((a, b) => (num(b.Composite_Entry_Score) ?? 0) - (num(a.Composite_Entry_Score) ?? 0))
    .slice(0, limit)
    .map((r) => ({
      ticker: bare(r.Ticker), side: 'entry', action: r.Action, conviction: r.Conviction_Tier,
      score: num(r.Composite_Entry_Score), price: num(r.Current_Price),
      put_wall: num(r.Put_Wall), suggested_usd: num(r.Suggested_USD), catalysts: r.Catalysts || null,
    }));

  const warnings = [
    ...freshnessWarnings(entries, 'Entry decisions'),
    ...freshnessWarnings(exits, 'Exit decisions'),
  ];

  return {
    success: true,
    exits: exitRows,
    entries: entryRows,
    counts: { exits: exitRows.length, entries: entryRows.length },
    critical_exits: exitRows.filter((r) => /CRITICAL/i.test(r.urgency || '')).map((r) => r.ticker),
    ...(warnings.length ? { warnings } : {}),
    instruction: [
      'Lead with CRITICAL exits — those are positions TA says are past their stop.',
      'These are TA\'s decisions, not recommendations produced here. Report them as TA\'s output.',
      'Say the age of the data; a stale exit signal may already have been acted on or invalidated.',
    ].join(' '),
  };
}

/**
 * Draw TA's levels for a symbol on the current chart.
 *
 * Renders as a labelled group so it can be cleared in one call, and so it is
 * distinguishable from anything drawn by hand.
 */
export async function drawDecision({ symbol, side = 'auto' } = {}) {
  const drawing = await import('./drawing.js');
  const chart = await import('./chart.js');

  const state = await chart.getState();
  const t = bare(symbol || state.symbol);

  let entry = null;
  let exit = null;
  if (side === 'entry' || side === 'auto') entry = await entryFor({ symbol: t }).catch(() => null);
  if (side === 'exit' || side === 'auto') exit = await exitFor({ symbol: t }).catch(() => null);

  if (!entry && !exit) {
    throw new Error(`TA has no entry or exit decision for ${t}. Entry decisions cover current candidates; exit decisions cover held positions.`);
  }

  const group = `ta-${side === 'auto' ? (exit ? 'exit' : 'entry') : side}-${t}`;
  const drawn = [];
  const warnings = [...(entry?.warnings || []), ...(exit?.warnings || [])];

  // Colour by meaning: stops red, resistance/targets green, support blue.
  const lines = [];
  if (exit) {
    const L = exit.levels;
    if (L.stop_price) lines.push({ price: L.stop_price, label: `TA Stop (${exit.urgency || 'exit'})`, color: '#F23645' });
    if (L.call_wall) lines.push({ price: L.call_wall, label: 'TA Call Wall', color: '#089981' });
    if (L.bb_upper) lines.push({ price: L.bb_upper, label: 'TA BB Upper', color: '#089981' });
    if (L.pif_resistance) lines.push({ price: L.pif_resistance, label: 'TA PIF Resistance', color: '#089981' });
  }
  if (entry) {
    const L = entry.levels;
    if (L.put_wall) lines.push({ price: L.put_wall, label: 'TA Put Wall', color: '#2962FF' });
    if (L.bb_lower) lines.push({ price: L.bb_lower, label: 'TA BB Lower', color: '#2962FF' });
    if (L.pif_support) lines.push({ price: L.pif_support, label: 'TA PIF Support', color: '#2962FF' });
  }

  if (!lines.length) {
    throw new Error(`TA has a decision for ${t} but no usable price levels in it — nothing to draw.`);
  }

  // Stagger labels by PRICE RANK so the ones that sit close together on screen
  // get different slots. TA's levels cluster tightly — a call wall, BB upper and
  // stop can land within a percent of each other — and same-slot labels overlap
  // into an unreadable smear. 'right' is excluded: it hides under the price scale.
  const SLOTS = [
    { horzLabelsAlign: 'center', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'center', vertLabelsAlign: 'top' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'top' },
  ];
  const rank = new Map([...lines].sort((a, b) => a.price - b.price).map((l, i) => [l, i]));

  for (const l of lines) {
    try {
      const r = await drawing.drawShape({
        shape: 'horizontal_line',
        point: { price: l.price },
        // Round for the label only — TA's raw values carry full float precision
        // ("143.238394"), which reads as noise on a chart.
        text: `${l.label} ${l.price >= 100 ? l.price.toFixed(2) : l.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`,
        group,
        overrides: JSON.stringify({
          linecolor: l.color, textcolor: l.color, linewidth: 2,
          linestyle: 2, showLabel: true,
          ...SLOTS[rank.get(l) % SLOTS.length],
        }),
      });
      drawn.push({ level: l.label, price: l.price, entity_id: r.entity_id });
    } catch (err) {
      warnings.push(`Could not draw ${l.label}: ${err.message}`);
    }
  }

  return {
    success: true,
    ticker: t,
    chart_symbol: state.symbol,
    group,
    drawn: drawn.length,
    levels: drawn,
    ...(entry ? { entry: { action: entry.action, conviction: entry.conviction, suggested_usd: entry.suggested_usd } } : {}),
    ...(exit ? { exit: { action: exit.action, urgency: exit.urgency, exit_pct: exit.exit_pct, return_pct: exit.total_return_pct } } : {}),
    age_hours: exit?.age_hours ?? entry?.age_hours ?? null,
    ...(warnings.length ? { warnings } : {}),
    clear_hint: `Remove with draw_clear group="${group}".`,
  };
}
