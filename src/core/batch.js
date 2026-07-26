/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import * as data from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  // waitForChartReady does the actual waiting; this is a small settle margin on
  // top of it, not the primary mechanism. It used to default to 2s per
  // iteration on top of the wait, which made a 10-symbol sweep needlessly slow.
  const delay = delay_ms ?? 250;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  // Remember where the user was. Batching drives the live chart, and without
  // this it abandons them on whatever symbol happened to be scanned last.
  let originalSymbol = null;
  let originalTimeframe = null;
  if (apiPath) {
    try {
      originalSymbol = await evaluate(`${apiPath}.symbol()`);
      originalTimeframe = await evaluate(`${apiPath}.resolution()`);
    } catch { /* restore becomes best-effort */ }
  }

  try {
  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        if (colPath) await evaluate(`${colPath}.setSymbol('${symbol}')`);
        else if (apiPath) await evaluate(`${apiPath}.setSymbol('${symbol}')`);

        if (tf) {
          if (colPath) await evaluate(`${colPath}.setResolution('${tf}')`);
          else if (apiPath) await evaluate(`${apiPath}.setResolution('${tf}')`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}.png`;
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          // Delegates to the same reader data_get_ohlcv uses. The previous
          // implementation called chart.exportData(), whose promise rejects on
          // this build — every get_ohlcv batch failed with an opaque
          // "Uncaught (in promise)" while the tool still reported success:true
          // at the top level.
          actionResult = await data.getOhlcv({ count: ohlcv_count || 100, summary: true });
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        } else {
          actionResult = { error: 'Unknown action or API not available: ' + action };
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }
  } finally {
    // Always hand the chart back, including when a symbol throws part-way.
    if (originalSymbol && apiPath) {
      try {
        await evaluate(`${apiPath}.setSymbol(${JSON.stringify(originalSymbol)})`);
        if (originalTimeframe) await evaluate(`${apiPath}.setResolution(${JSON.stringify(originalTimeframe)})`);
        await waitForChartReady(originalSymbol, originalTimeframe, 8000);
      } catch { /* nothing more we can do */ }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return {
    success: true,
    total_iterations: results.length,
    successful: successCount,
    failed: results.length - successCount,
    chart_restored_to: originalSymbol ? { symbol: originalSymbol, timeframe: originalTimeframe } : null,
    results,
  };
}
