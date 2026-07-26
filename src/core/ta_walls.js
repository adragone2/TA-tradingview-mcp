/**
 * Gamma walls from Tactical Alpha, formatted for the Institutional Matrix Pro
 * indicator's JSON input.
 *
 * TA's walls_scanner computes call/put OI walls, GEX walls, gamma flip and
 * implied move per expiry horizon and publishes them as the walls_history
 * dataset. The indicator takes the same numbers as a compact JSON string,
 * which until now was pasted in by hand — so it went stale and could be left
 * describing a different instrument than the chart.
 *
 * The compact schema is reproduced exactly from ta_core/screeners/walls_scanner.py:
 *   {d,w,m} x {CW, PW, CGX, PGX, S}  +  flip, im, vix, vvix, ts
 * where the horizon prefixes are Daily/Weekly/Monthly and S is a strength
 * flag: 4 when either side's open interest clears the threshold, else 2, or 0
 * when that horizon has no data.
 */
import * as ta from './ta_api.js';

// Matches STRENGTH_THRESHOLD in walls_scanner.py. If that constant changes,
// this must change with it or the indicator's strength banding will disagree
// with TA's own reports.
const STRENGTH_THRESHOLD = 10000;

const HORIZONS = [['Daily', 'd'], ['Weekly', 'w'], ['Monthly', 'm']];

// walls_history is ~16 MB. Cached per process so applying walls across a
// watchlist does not refetch it for every symbol.
let cache = null;
const CACHE_TTL_MS = 15 * 60 * 1000;

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return { lines, header, idx };
}

/** Strip the exchange prefix: "BATS:SMH" -> "SMH". */
export function bareTicker(symbol) {
  return String(symbol || '').toUpperCase().replace(/^.*:/, '').trim();
}

/**
 * Fetch and index the newest wall snapshot per ticker.
 * Returns { asOf, byTicker: Map<ticker, {Daily, Weekly, Monthly}>, tickers, rows }
 */
/**
 * Where walls come from, in preference order.
 *
 * walls_json is the per-user scan covering the whole watchlist — equities
 * included — but it is classified PORTFOLIO_SPECIFIC, and /api/v1/sync serves
 * only SHARED datasets, so it currently 403s. TA has the loader machinery
 * (load_user_csv resolves user-scoped files, and the username is already
 * derived from the API key) but no route wired to it.
 *
 * walls_history is the SHARED fallback: a curated 22-ticker sector-ETF archive.
 * Correct data, narrower universe.
 *
 * Both are tried so this starts using the full watchlist the moment a route
 * exists, with no change here. Set TA_WALLS_ENDPOINT to point at it.
 */
const WALLS_SOURCES = [
  { name: 'walls_json', path: process.env.TA_WALLS_ENDPOINT || '/api/walls', scope: 'watchlist (all symbols)' },
  { name: 'walls_history', path: '/api/v1/sync/walls_history', scope: 'sector-ETF universe only' },
];

/**
 * Parse the Ticker,TV_JSON form served by /api/walls.
 *
 * TV_JSON is the compact payload walls_scanner itself emits, so using it
 * directly avoids reconstructing the numbers and avoids any chance of this
 * module's arithmetic drifting from TA's.
 *
 * Split on the FIRST comma only — the JSON column is unquoted and full of
 * commas, so a naive CSV split shreds every row.
 */
function parseTvJsonCsv(text) {
  const lines = text.trim().split('\n');
  const byTicker = new Map();
  const bad = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    const ticker = line.slice(0, comma).trim().toUpperCase();
    let json = line.slice(comma + 1).trim();
    if (json.startsWith('"') && json.endsWith('"')) json = json.slice(1, -1).replace(/""/g, '"');
    try {
      const payload = JSON.parse(json);
      if (ticker) byTicker.set(ticker, { ticker, ready: payload });
    } catch {
      bad.push(ticker || `line ${i}`);
    }
  }
  return { byTicker, bad };
}

export async function loadWalls({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let text = '';
  let source = null;
  let freshness = null;
  const attempts = [];

  for (const src of WALLS_SOURCES) {
    try {
      const res = await ta.get(src.path, { timeoutMs: 120000, raw: true });
      const body = res.text || (typeof res.data === 'string' ? res.data : '');
      if (body && /ticker/i.test(body)) {
        text = body;
        source = src;
        freshness = res.freshness || null;
        break;
      }
      attempts.push(`${src.name}: empty or unrecognised payload`);
    } catch (err) {
      attempts.push(`${src.name}: ${err.message.slice(0, 120)}`);
    }
  }

  if (!text) {
    throw new Error(`Could not load walls from TA. Tried:\n  - ${attempts.join('\n  - ')}`);
  }

  // /api/walls serves ready-made payloads; walls_history serves raw per-horizon
  // rows that still need assembling.
  const header = text.slice(0, text.indexOf('\n')).toLowerCase();
  if (header.includes('tv_json')) {
    const { byTicker, bad } = parseTvJsonCsv(text);
    const staleHours = freshness?.age_hours;
    const value = {
      asOf: freshness?.generated_at || null,
      age_hours: staleHours ?? null,
      byTicker,
      tickers: [...byTicker.keys()].sort(),
      rows: byTicker.size,
      source: source.name,
      format: 'tv_json',
      coverage_scope: source.scope,
      ...(bad.length ? { unparsed: bad } : {}),
    };
    cache = { at: Date.now(), value };
    return value;
  }

  const { lines, idx } = parseCsv(text);
  const need = ['snapshot_date', 'ticker', 'horizon', 'spot', 'call_wall', 'put_wall',
    'call_gex_wall', 'put_gex_wall', 'call_oi', 'put_oi', 'gamma_flip', 'implied_move', 'status'];
  const missing = need.filter((c) => idx[c] === undefined);
  if (missing.length) {
    throw new Error(`walls_history is missing expected columns: ${missing.join(', ')}. The dataset schema may have changed.`);
  }

  // Keep only the most recent snapshot for each ticker+horizon. The file is
  // append-only history, so the same ticker appears on many dates.
  const byTicker = new Map();
  let asOf = null;

  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const date = f[idx.snapshot_date];
    const ticker = (f[idx.ticker] || '').toUpperCase();
    const horizon = f[idx.horizon];
    if (!date || !ticker || !horizon) continue;
    if (!asOf || date > asOf) asOf = date;

    let entry = byTicker.get(ticker);
    if (!entry) { entry = { ticker, date: null, horizons: {} }; byTicker.set(ticker, entry); }
    if (entry.date && date < entry.date) continue;
    if (entry.date !== date) { entry.date = date; entry.horizons = {}; }

    const num = (c) => { const v = Number(f[idx[c]]); return Number.isFinite(v) ? v : 0; };
    entry.horizons[horizon] = {
      status: f[idx.status],
      spot: num('spot'),
      CW: Math.round(num('call_wall')),
      PW: Math.round(num('put_wall')),
      CGX: Math.round(num('call_gex_wall')),
      PGX: Math.round(num('put_gex_wall')),
      call_oi: num('call_oi'),
      put_oi: num('put_oi'),
      FLIP: Math.round(num('gamma_flip')),
      IM: num('implied_move'),
      expiry: f[idx.expiry_date],
    };
  }

  const value = {
    asOf,
    byTicker,
    tickers: [...byTicker.keys()].sort(),
    rows: lines.length - 1,
    source: source.name,
    coverage_scope: source.scope,
    ...(source.name === 'walls_history'
      ? { limitation: 'Using the SHARED sector-ETF archive because the per-user walls_json dataset has no API route (it is PORTFOLIO_SPECIFIC and /api/v1/sync serves SHARED only). Equities on the watchlist are not covered until TA exposes it.' }
      : {}),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** VIX and VVIX from TA, so the indicator's volatility context matches TA's. */
async function volatility() {
  const out = { vix: 0, vvix: 0, source: 'unavailable' };
  try {
    const v = await ta.vix();
    const lvl = v.data?.vix_level;
    if (Number.isFinite(lvl)) { out.vix = Math.round(lvl * 100) / 100; out.source = 'ta'; }
  } catch { /* leave at 0 */ }
  try {
    const vr = await ta.volRegime();
    const vv = vr.data?.vvix_level;
    if (Number.isFinite(vv)) out.vvix = Math.round(vv * 100) / 100;
  } catch { /* leave at 0 */ }
  return out;
}

/**
 * Build the indicator's compact JSON for one ticker.
 * Returns { ticker, json, payload, as_of, horizons_present, warnings }
 */
export async function buildWallsJson({ symbol, walls, vol } = {}) {
  const ticker = bareTicker(symbol);
  if (!ticker) throw new Error('symbol is required.');

  const data = walls || await loadWalls();
  const entry = data.byTicker.get(ticker);
  if (!entry) {
    throw new Error(
      `No wall data for ${ticker}. TA's walls coverage is ${data.tickers.length} tickers ` +
      `(${data.tickers.slice(0, 8).join(', ')}…). Options-derived walls only exist for names with a liquid chain.`,
    );
  }

  const warnings = [];

  // Freshness comes from the source file's mtime, so a successful fetch says
  // nothing about currency. TA refreshes walls each weekday after ~19:30 UTC;
  // past ~30h on a trading day means the upstream scan did not run.
  if (Number.isFinite(data.age_hours)) {
    if (data.age_hours > 30) {
      warnings.push(`Walls are ${Math.round(data.age_hours)}h old (TA refreshes each weekday after ~19:30 UTC). Past ~30h on a trading day means TA's scan did not run — the levels describe old positioning.`);
    }
  } else if (data.format === 'tv_json') {
    warnings.push('TA did not report a freshness header, so the age of these walls is unknown.');
  }

  // /api/walls already carries the exact payload walls_scanner emits. Use it
  // verbatim rather than rebuilding — reconstructing risks drifting from TA.
  if (entry.ready) {
    const ready = { ...entry.ready };
    const horizonsPresent = [['Daily', 'd'], ['Weekly', 'w'], ['Monthly', 'm']]
      .filter(([, p]) => Number(ready[`${p}S`]) > 0)
      .map(([n]) => n);

    for (const [name, p] of HORIZONS) {
      if (Number(ready[`${p}S`]) === 0) warnings.push(`No ${name} horizon for ${ticker} — its keys are zero.`);
    }

    return {
      success: true,
      ticker,
      as_of: data.asOf,
      age_hours: data.age_hours ?? null,
      source: data.source,
      horizons_present: horizonsPresent,
      payload: ready,
      json: JSON.stringify(ready),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const v = vol || await volatility();
  const payload = {};
  const present = [];

  for (const [name, prefix] of HORIZONS) {
    const h = entry.horizons[name];
    if (h) {
      present.push(name);
      payload[`${prefix}CW`] = h.CW;
      payload[`${prefix}PW`] = h.PW;
      payload[`${prefix}CGX`] = h.CGX;
      payload[`${prefix}PGX`] = h.PGX;
      payload[`${prefix}S`] = (h.call_oi >= STRENGTH_THRESHOLD || h.put_oi >= STRENGTH_THRESHOLD) ? 4 : 2;
      if (h.status && h.status !== 'OK') warnings.push(`${name} horizon is ${h.status} — the option chain was thin, so these levels are less reliable.`);
    } else {
      payload[`${prefix}CW`] = 0;
      payload[`${prefix}PW`] = 0;
      payload[`${prefix}CGX`] = 0;
      payload[`${prefix}PGX`] = 0;
      payload[`${prefix}S`] = 0;
      warnings.push(`No ${name} horizon in the latest snapshot.`);
    }
  }

  // Primary horizon matches walls_scanner: Weekly when present, else Daily.
  const primary = entry.horizons.Weekly || entry.horizons.Daily;
  payload.flip = primary ? primary.FLIP : 0;
  payload.im = primary ? primary.IM : 0;
  payload.vix = v.vix;
  payload.vvix = v.vvix;
  payload.ts = Math.floor(Date.parse(`${entry.date}T00:00:00Z`) / 1000) || Math.floor(Date.now() / 1000);

  if (v.source !== 'ta') warnings.push('VIX/VVIX could not be read from TA and are zeroed.');

  const ageDays = Math.round((Date.now() - Date.parse(`${entry.date}T00:00:00Z`)) / 86400000);
  if (ageDays > 3) warnings.push(`Snapshot is ${ageDays} days old (${entry.date}). Walls move with the option chain — refresh TA's scanner before relying on these.`);

  return {
    success: true,
    ticker,
    as_of: entry.date,
    age_days: ageDays,
    horizons_present: present,
    spot_at_snapshot: primary?.spot ?? null,
    payload,
    json: JSON.stringify(payload),
    ...(warnings.length ? { warnings } : {}),
  };
}

const MATRIX_NAME_MATCH = /institutional\s*matrix/i;
const WALLS_INPUT_ID = 'in_0';

/** Locate the Institutional Matrix study on the current chart. */
export async function findMatrixStudy() {
  const chart = await import('./chart.js');
  const state = await chart.getState();
  const studies = state.studies || state.indicators || [];
  const hit = studies.find((s) => MATRIX_NAME_MATCH.test(String(s.name || s)));
  if (!hit) {
    throw new Error(
      `No Institutional Matrix indicator on this chart. Found: ${studies.map((s) => s.name || s).join(', ') || 'none'}. ` +
      'Switch to the layout that has it (layout_switch "TA-Trading") or add it to the chart.',
    );
  }
  return { entity_id: hit.entity_id || hit.id, name: hit.name || String(hit), symbol: state.symbol, resolution: state.resolution };
}

/**
 * Write TA's walls into the indicator for the symbol currently on the chart.
 *
 * Verifies the value landed rather than assuming — setInputValues silently
 * ignores an id the study does not have.
 */
export async function applyWalls({ symbol, walls, vol, dry_run = false } = {}) {
  const study = await findMatrixStudy();
  const target = symbol || study.symbol;
  const built = await buildWallsJson({ symbol: target, walls, vol });

  if (dry_run) {
    return { ...built, applied: false, dry_run: true, entity_id: study.entity_id, chart_symbol: study.symbol };
  }

  const ind = await import('./indicators.js');
  const data = await import('./data.js');

  await ind.setInputs({ entity_id: study.entity_id, inputs: { [WALLS_INPUT_ID]: built.json } });
  await new Promise((r) => setTimeout(r, 800));

  const after = await data.getIndicator({ entity_id: study.entity_id });
  const written = (after.inputs || []).find((i) => (i.id || i.name) === WALLS_INPUT_ID)?.value;
  if (written !== built.json) {
    throw new Error(
      `Wrote walls for ${built.ticker} but the indicator input did not take. ` +
      'The study may have been removed, or its input layout changed.',
    );
  }

  return { ...built, applied: true, verified: true, entity_id: study.entity_id, chart_symbol: study.symbol };
}

/**
 * Apply walls across several symbols, switching the chart to each in turn.
 * The chart is returned to where it started.
 */
export async function applyWallsForSymbols({ symbols, dry_run = false } = {}) {
  const list = (symbols || []).map(bareTicker).filter(Boolean);
  if (!list.length) throw new Error('symbols is required, e.g. ["SMH","XLK"].');

  const chart = await import('./chart.js');
  const walls = await loadWalls();
  const vol = await volatility();

  let originalSymbol = null;
  let originalTimeframe = null;
  try {
    const s = await chart.getState();
    originalSymbol = s.symbol;
    originalTimeframe = s.resolution;
  } catch { /* restore becomes best-effort */ }

  const results = [];
  try {
    for (const sym of list) {
      try {
        await chart.setSymbol({ symbol: sym });
        const r = await applyWalls({ symbol: sym, walls, vol, dry_run });
        results.push({ symbol: sym, ok: true, as_of: r.as_of, flip: r.payload.flip, applied: r.applied, warnings: r.warnings });
      } catch (err) {
        results.push({ symbol: sym, ok: false, error: err.message });
      }
    }
  } finally {
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
      } catch { /* nothing more we can do */ }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return {
    success: true,
    as_of: walls.asOf,
    requested: list.length,
    applied: ok,
    failed: results.length - ok,
    chart_restored_to: originalSymbol ? { symbol: originalSymbol, timeframe: originalTimeframe } : null,
    results,
    note: 'Walls are written into the indicator per symbol. The chart shows one symbol at a time, so re-apply when switching to a symbol you have not done yet.',
  };
}

export async function listCoverage() {
  const data = await loadWalls();
  return {
    success: true,
    as_of: data.asOf,
    source: data.source,
    coverage_scope: data.coverage_scope,
    ticker_count: data.tickers.length,
    tickers: data.tickers,
    rows: data.rows,
    ...(data.limitation ? { limitation: data.limitation } : {}),
  };
}
