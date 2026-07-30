/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { applyInputs } from './indicators.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function getState() {
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol }) {
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
    throw new Error('A symbol is required, e.g. "CSCO" or "NASDAQ:CSCO".');
  }
  const requested = symbol.trim();
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${requested.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(requested);
  // Report what the chart actually loaded, not what was asked for. TradingView
  // resolves a bare ticker to an exchange-qualified symbol, and silently keeps
  // the previous one when it cannot — echoing the input hides both.
  const resolved = await evaluate(`${CHART_API}.symbol()`);
  return { success: true, symbol: requested, resolved_symbol: resolved || null, chart_ready: ready };
}

/**
 * Normalise a TradingView resolution, or return null if it is not one.
 *
 * Resolutions are minutes as a bare number ("5", "240"), or a count plus a
 * unit — S(econd), D(ay), W(eek), M(onth), T(ick), R(ange). The count may be
 * omitted for a single unit, so "D" and "1D" are both a daily chart.
 */
export function parseResolution(timeframe) {
  const raw = String(timeframe ?? '').trim();
  const m = raw.match(/^(\d+)$|^(\d*)([SDWMTR])$/i);
  if (!m) return null;
  const count = m[1] ?? m[2];
  // "0" and "0D" are not resolutions. A bare unit means one of it.
  if (count !== '' && Number(count) < 1) return null;
  return m[1] !== undefined ? raw : `${m[2]}${m[3].toUpperCase()}`;
}

export async function setTimeframe({ timeframe }) {
  // Without this an unrecognised argument went straight to setResolution, which
  // fails silently — the chart kept its old timeframe while the call reported
  // success on the one that was asked for.
  const resolution = parseResolution(timeframe);
  if (!resolution) {
    throw new Error(
      `Invalid timeframe "${timeframe}". Use minutes ("5", "60", "240"), or a count and unit: ` +
      '"30S", "D", "1D", "3W", "M", "1T", "10R".',
    );
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution('${resolution.replace(/'/g, "\\'")}', {});
    })()
  `);
  const ready = await waitForChartReady(null, resolution);
  const actual = await evaluate(`${CHART_API}.resolution()`);
  return { success: true, timeframe: resolution, resolved_resolution: actual ?? null, chart_ready: ready };
}

export async function setType({ chart_type }) {
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    /**
     * createStudy's 4th argument takes RAW VALUES POSITIONALLY, in the study's own
     * declared input order — NOT [{id, value}] objects. Passing objects made
     * TradingView fall back to every default while still creating the study, so
     * "Moving Average" with { length: 200 } silently became a 9-period MA and the
     * add still reported success. Since the declared order is not known before the
     * study exists, create it bare and set the inputs by ID afterwards, which is
     * verifiable.
     */
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, []);
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    const entityId = newIds[0] || null;

    let inputResult = null;
    if (inputs && Object.keys(inputs).length && entityId) {
      try {
        inputResult = await applyInputs({ entity_id: entityId, overrides: inputs });
      } catch (err) {
        inputResult = { inputs_verified: false, input_error: err.message };
      }
    }

    return {
      success: newIds.length > 0 && (inputResult ? inputResult.inputs_verified : true),
      action: 'add',
      indicator,
      entity_id: entityId,
      new_study_count: newIds.length,
      ...(inputResult || {}),
    };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to }) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}

/**
 * Make the chart HOLD enough history, then say how much it got.
 *
 * TradingView loads a viewport's worth of bars and no more — measured on AAPL, a
 * fresh 5-minute chart holds **300 bars, which is two sessions**. Every detector
 * here then reads two sessions of structure and reports it as a finding. The daily
 * timeframe hides the problem because 300 daily bars is fifteen months.
 *
 * `mainSeries().requestMoreData(n)` extends it, and it does work: six calls took
 * that same chart from 300 to 3,312 bars. It is asynchronous with no completion
 * signal, so this polls the bar count and stops when it stops growing — a symbol
 * that genuinely has no more history must not spin.
 *
 * Read the bars with `data.getOhlcv({ count, max })`: the reader has its own 500-bar
 * cap for context reasons, and loading history the caller cannot read is pointless.
 */
export async function loadHistory({ min_bars = 800, max_requests = 12, settle_ms = 900 } = {}) {
  const barCount = async () => {
    try {
      return await evaluate(`${CHART_API}._chartWidget.model().mainSeries().bars().size()`);
    } catch { return null; }
  };

  const started = await barCount();
  if (started == null) {
    return { success: false, bars: null, note: 'could not read the series bar count — chart not ready?' };
  }

  let have = started;
  let requests = 0;
  while (have < min_bars && requests < max_requests) {
    const before = have;
    try {
      await evaluate(`${CHART_API}._chartWidget.model().mainSeries().requestMoreData(500)`);
    } catch (e) {
      return { success: false, bars: have, requested: requests, note: `requestMoreData failed: ${e.message}` };
    }
    await new Promise((r) => setTimeout(r, settle_ms));
    have = (await barCount()) ?? before;
    requests += 1;
    // No growth means the feed has no more history for this symbol and resolution.
    // Spinning to max_requests would add ~10s per symbol across a whole watchlist.
    if (have <= before) {
      return {
        success: true, bars: have, started, requested: requests, exhausted: true,
        reached_target: have >= min_bars,
        note: `history exhausted at ${have} bars (asked for ${min_bars}) — the feed has no more at this resolution`,
      };
    }
  }
  return {
    success: true, bars: have, started, requested: requests,
    exhausted: false,
    reached_target: have >= min_bars,
    ...(have < min_bars ? { note: `stopped at ${have} bars after ${requests} requests (wanted ${min_bars})` } : {}),
  };
}
