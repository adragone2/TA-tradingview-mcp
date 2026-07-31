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
import { resolveTaSymbol } from './ta_symbols.js';

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
 * Returns { asOf, byTicker: Map, tickers, rows } — and, when a `symbol` was
 * asked for, { requested, covered, walls, coverage } with the map narrowed to
 * it. See wallsManifest and symbolView below for why both shapes are built in
 * one place.
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
/**
 * Exported for testing. Each row is `TICKER,<json>` where the JSON may be
 * quote-wrapped with doubled inner quotes. A row that fails to parse must be
 * COLLECTED rather than thrown on — one malformed ticker should not lose the
 * other twenty-one.
 */
export function parseTvJsonCsv(text) {
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

/**
 * Build the manifest both parse branches return.
 *
 * `byTicker` is a Map — and `JSON.stringify(new Map())` is `{}`. Silently: no
 * throw, no warning, no missing-field to notice. That is how every walls block
 * in the Sunday review came out `rows: 40, byTicker: {}` while forty entries
 * sat in memory with AMD's levels in them. The count and the coverage list
 * survived because the same parse had already materialised them into a number
 * and an array; only the Map — the part carrying the actual walls — did not.
 *
 * So the wire shape is built HERE, once, and `byTicker`, `tickers` and `rows`
 * are ALL read off the same Map at serialisation time. They cannot disagree
 * again, because there is nowhere left for them to disagree: a populated count
 * beside an empty map is no longer a representable state.
 *
 * `rows` therefore means "entries indexed", in both branches. walls_history's
 * raw line count is a different quantity (it is append-only, so one ticker owns
 * many lines) and is reported separately as `source_rows`.
 */
function wallsManifest(byTicker, fields = {}) {
  const wire = () => ({
    tickers: [...byTicker.keys()].sort(),
    rows: byTicker.size,
  });
  const view = { ...fields, byTicker, ...wire() };
  // Non-enumerable so a spread or Object.keys of the manifest is unchanged, and
  // so the plain object toJSON returns carries no toJSON of its own to recurse
  // into.
  Object.defineProperty(view, 'toJSON', {
    enumerable: false,
    value() {
      const { byTicker: map, ...rest } = view;
      return { ...rest, ...wire(), byTicker: Object.fromEntries(map) };
    },
  });
  return view;
}

/**
 * The view for one requested symbol.
 *
 * `loadWalls({ symbol })` used to ignore `symbol` entirely — the argument was
 * never in the signature — so `ticker_analyze`'s per-ticker call answered with
 * the whole coverage manifest and nothing about the ticker it had asked for.
 *
 * The narrowed map keeps the invariant above intact: `byTicker`, `tickers` and
 * `rows` describe the ANSWER, and the full coverage is preserved verbatim under
 * `coverage`. So a covered-but-unrequested symbol is absent from `byTicker` and
 * present in `coverage.tickers` — a distinction the caller can act on, rather
 * than 39 other tickers' payloads copied into every row of the report.
 */
function symbolView(full, symbol) {
  const ticker = bareTicker(symbol);
  const entry = full.byTicker.get(ticker) || null;
  const { byTicker, tickers, rows, ...rest } = full;
  return wallsManifest(entry ? new Map([[ticker, entry]]) : new Map(), {
    ...rest,
    requested: ticker,
    covered: Boolean(entry),
    // The indexed entry verbatim. Building the indicator payload from it is
    // buildWallsJson's job and must not be duplicated here.
    walls: entry,
    coverage: { ticker_count: tickers.length, tickers, rows },
  });
}

/**
 * `get` is injectable so the parse can be tested against the REAL file's shape
 * without the network — the same fixture style buildWallsJson and
 * applyWallsForSymbols already use. An injected fetch NEVER touches the process
 * cache, in either direction: a fixture must not be served to a live caller,
 * and a live snapshot must not be served to a test.
 */
export async function loadWalls({ force = false, symbol = null, get } = {}) {
  const full = await loadAllWalls({ force, get });
  return symbol ? symbolView(full, symbol) : full;
}

async function loadAllWalls({ force = false, get } = {}) {
  const fetchOne = get || ta.get;
  const shared = !get;
  if (shared && !force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let text = '';
  let source = null;
  let freshness = null;
  const attempts = [];

  for (const src of WALLS_SOURCES) {
    try {
      const res = await fetchOne(src.path, { timeoutMs: 120000, raw: true });
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
    const value = wallsManifest(byTicker, {
      asOf: freshness?.generated_at || null,
      age_hours: staleHours ?? null,
      source: source.name,
      format: 'tv_json',
      coverage_scope: source.scope,
      ...(bad.length ? { unparsed: bad } : {}),
    });
    if (shared) cache = { at: Date.now(), value };
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

  const value = wallsManifest(byTicker, {
    asOf,
    // The file is append-only history, so its line count and the number of
    // tickers indexed are different quantities. `rows` is the second one, in
    // both branches; this is the first, and it is named for what it counts.
    source_rows: lines.length - 1,
    source: source.name,
    coverage_scope: source.scope,
    ...(source.name === 'walls_history'
      ? { limitation: 'Using the SHARED sector-ETF archive because the per-user walls_json dataset has no API route (it is PORTFOLIO_SPECIFIC and /api/v1/sync serves SHARED only). Equities on the watchlist are not covered until TA exposes it.' }
      : {}),
  });
  if (shared) cache = { at: Date.now(), value };
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
    // A narrowed per-symbol view holds one ticker in byTicker and the whole
    // universe under `coverage`. Reporting the narrowed count as "TA's walls
    // coverage" would tell the reader the coverage had collapsed to 1.
    const covered = data.coverage?.tickers || data.tickers || [];
    throw new Error(
      `No wall data for ${ticker}. TA's walls coverage is ${covered.length} tickers ` +
      `(${covered.slice(0, 8).join(', ')}…). Options-derived walls only exist for names with a liquid chain.`,
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
 *
 * Every ticker goes through resolveTaSymbol BEFORE the chart is driven:
 * TradingView reads a hyphen as a SPREAD operator, so a TA ticker like BTC-USD
 * does not fail — it silently loads CRYPTOCAP:BTC-BATS:USD, a synthetic series
 * with a real price, and the walls would land on the wrong instrument under the
 * right name. Unchartable tickers are SKIPPED with the reason (separately from
 * FAILED — one was never attempted, the other broke), and every load is
 * verified against what the chart says it loaded, the same guard
 * scripts/sunday-review.js loadSymbol() uses, because the resolver cannot know
 * every trap: BRK-B is a share class, not crypto, and still reads as a spread.
 *
 * `walls`, `vol`, `chart` and `applyOne` are injectable for tests, like
 * buildWallsJson's fixtures; live callers pass none of them.
 */
export async function applyWallsForSymbols({ symbols, dry_run = false, walls, vol, chart: chartDep, applyOne } = {}) {
  const list = (symbols || []).map(bareTicker).filter(Boolean);
  if (!list.length) throw new Error('symbols is required, e.g. ["SMH","XLK"].');

  // Data before chart: a failure to load walls must not leave the chart moved.
  const wallsData = walls || await loadWalls();
  const v = vol || await volatility();
  const chart = chartDep || await import('./chart.js');
  const apply = applyOne || applyWalls;

  // Captured lazily, just before the first symbol actually drives the chart —
  // an all-skipped list then never touches the shared chart at all, not even
  // to "restore" it to where it already is.
  let originalSymbol = null;
  let originalTimeframe = null;
  let driven = false;

  const results = [];
  try {
    for (const sym of list) {
      const resolved = resolveTaSymbol(sym);
      if (!resolved.chartable) {
        results.push({ symbol: sym, ok: false, skipped: true, why: resolved.why });
        continue;
      }
      try {
        if (!driven) {
          driven = true;
          try {
            const s = await chart.getState();
            originalSymbol = s.symbol;
            originalTimeframe = s.resolution;
          } catch { /* restore becomes best-effort */ }
        }
        const load = await chart.setSymbol({ symbol: resolved.symbol });
        // setSymbol reports what the chart ACTUALLY loaded. Compare bare forms:
        // "SMH" legitimately loads as "BATS:SMH", but a spread's last segment
        // ("USD", "B") never matches the ticker asked for. No answer is also a
        // refusal — an unverifiable load must not have walls written onto it.
        const got = String(load?.resolved_symbol || '').replace(/^.*:/, '').toUpperCase();
        const want = resolved.expect.toUpperCase();
        if (!got || got !== want) {
          throw new Error(
            `chart returned ${load?.resolved_symbol || 'no symbol'}, expected ${resolved.symbol} — `
            + `refusing to write ${sym}'s walls onto a different instrument`,
          );
        }
        const r = await apply({ symbol: sym, walls: wallsData, vol: v, dry_run });
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
  const skipped = results.filter((r) => r.skipped).length;
  return {
    success: true,
    as_of: wallsData.asOf,
    requested: list.length,
    applied: ok,
    skipped,
    failed: results.length - ok - skipped,
    chart_restored_to: originalSymbol ? { symbol: originalSymbol, timeframe: originalTimeframe } : null,
    results,
    note: 'Walls are written into the indicator per symbol. The chart shows one symbol at a time, so re-apply when switching to a symbol you have not done yet.',
  };
}

/**
 * Draw TA's walls as native chart lines instead of writing them into the
 * Institutional Matrix indicator.
 *
 * walls_apply remains the better default where the indicator is present: it
 * renders a panel (VIX/VVIX, flip, expected move) and its own freshness verdict,
 * and it recalculates with the chart. These lines are a static snapshot.
 *
 * This exists for the cases the indicator cannot cover:
 *   - any layout without the indicator, which is most of them
 *   - showing walls alongside entry/exit levels in one visual system
 *   - levels that can be read back with draw_list and cleared by group
 */
const WALL_STYLE = {
  CW: { label: 'Call Wall', color: '#089981', gex: false },   // resistance
  PW: { label: 'Put Wall', color: '#2962FF', gex: false },    // support
  CGX: { label: 'Call GEX', color: '#089981', gex: true },
  PGX: { label: 'Put GEX', color: '#2962FF', gex: true },
};
const HORIZON_LABEL = { d: 'D', w: 'W', m: 'M' };
const FLIP_COLOR = '#FF9800';

export async function drawWalls({
  symbol,
  horizons = ['d', 'w'],
  include_gex = true,
  include_flip = true,
  merge_within_pct = 0.5,
  walls,
  vol,
} = {}) {
  const drawing = await import('./drawing.js');
  const chart = await import('./chart.js');

  const state = await chart.getState();
  const target = symbol || state.symbol;
  const built = await buildWallsJson({ symbol: target, walls, vol });
  const p = built.payload;

  const wanted = (horizons || ['d', 'w']).map((h) => String(h).toLowerCase()).filter((h) => HORIZON_LABEL[h]);
  if (!wanted.length) throw new Error('horizons must contain one or more of "d", "w", "m".');

  // Collect levels, merging any that land on the same price. TA's horizons
  // frequently agree (a weekly and monthly call wall at the same strike), and
  // stacking identical lines is noise rather than information.
  const byPrice = new Map();
  for (const h of wanted) {
    // Strength 0 means that horizon had no data and its keys are zeros.
    if (Number(p[`${h}S`]) === 0) continue;
    for (const [key, style] of Object.entries(WALL_STYLE)) {
      if (style.gex && !include_gex) continue;
      const price = Number(p[`${h}${key}`]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const existing = byPrice.get(price);
      if (existing) {
        existing.tags.push(`${HORIZON_LABEL[h]} ${style.label}`);
      } else {
        byPrice.set(price, {
          price,
          tags: [`${HORIZON_LABEL[h]} ${style.label}`],
          color: style.color,
          gex: style.gex,
          horizon: h,
        });
      }
    }
  }

  if (include_flip && Number(p.flip) > 0) {
    const flip = Number(p.flip);
    const existing = byPrice.get(flip);
    if (existing) existing.tags.unshift('Gamma Flip');
    else byPrice.set(flip, { price: flip, tags: ['Gamma Flip'], color: FLIP_COLOR, gex: false, flip: true });
  }

  // Merge levels that sit too close to tell apart on screen. Exact-price
  // matching is not enough: a gamma flip at 583 between GEX walls at 582 and
  // 585 renders as three overlapping labels in a 3-point band, which is worse
  // than one line reading "D Call GEX / Gamma Flip / W Call GEX". Merged
  // entries keep the flip's colour and weight, since that is the level being
  // read against.
  const tolerance = Math.max(Number(merge_within_pct) || 0, 0) / 100;
  let levels = [...byPrice.values()].sort((a, b) => a.price - b.price);

  if (tolerance > 0 && levels.length > 1) {
    const merged = [];
    for (const l of levels) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(l.price - prev.price) <= prev.price * tolerance) {
        prev.tags.push(...l.tags);
        prev.merged = (prev.merged || 1) + 1;
        if (l.flip) { prev.flip = true; prev.color = FLIP_COLOR; }
        if (!l.gex) prev.gex = false;
        if (l.horizon === 'd') prev.horizon = 'd';
      } else {
        merged.push({ ...l, tags: [...l.tags] });
      }
    }
    levels = merged;
  }

  if (!levels.length) {
    throw new Error(`TA has walls for ${built.ticker} but no usable levels in the requested horizons (${wanted.join(', ')}).`);
  }

  const group = `walls-${built.ticker}`;
  // Same price-rank staggering used elsewhere: wall levels cluster tightly and
  // same-slot labels overlap into an unreadable smear.
  const SLOTS = [
    { horzLabelsAlign: 'center', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'center', vertLabelsAlign: 'top' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'bottom' },
    { horzLabelsAlign: 'left', vertLabelsAlign: 'top' },
  ];
  const rank = new Map([...levels].sort((a, b) => a.price - b.price).map((l, i) => [l, i]));

  const drawn = [];
  const warnings = [...(built.warnings || [])];

  for (const l of levels) {
    const label = l.tags.join(' / ');
    try {
      const r = await drawing.drawShape({
        shape: 'horizontal_line',
        point: { price: l.price },
        text: `${label} ${l.price}`,
        group,
        overrides: JSON.stringify({
          linecolor: l.color,
          textcolor: l.color,
          // Flip is the pivot everything else is read against, so it is drawn
          // heaviest. GEX walls are dashed to separate them from OI walls.
          linewidth: l.flip ? 3 : (l.horizon === 'd' ? 2 : 1),
          linestyle: l.flip ? 0 : (l.gex ? 2 : 0),
          showLabel: true,
          ...SLOTS[rank.get(l) % SLOTS.length],
        }),
      });
      drawn.push({ price: l.price, label, entity_id: r.entity_id });
    } catch (err) {
      warnings.push(`Could not draw ${label} at ${l.price}: ${err.message}`);
    }
  }

  return {
    success: true,
    ticker: built.ticker,
    chart_symbol: state.symbol,
    group,
    horizons: wanted,
    drawn: drawn.length,
    levels: drawn,
    as_of: built.as_of,
    age_hours: built.age_hours ?? null,
    flip: Number(p.flip) || null,
    implied_move: Number(p.im) || null,
    ...(warnings.length ? { warnings } : {}),
    note: 'Static snapshot drawn as chart lines. walls_apply writes the same data into the Institutional Matrix indicator instead, which also renders a panel and recalculates with the chart — prefer it when that indicator is on the layout.',
    clear_hint: `Remove with draw_clear group="${group}".`,
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
    // walls_history is append-only, so it holds many lines per ticker. Absent
    // for walls_json, where one line IS one ticker.
    ...(data.source_rows != null ? { source_rows: data.source_rows } : {}),
    ...(data.limitation ? { limitation: data.limitation } : {}),
  };
}
