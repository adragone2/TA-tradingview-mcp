/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi, KNOWN_PATHS } from '../connection.js';

/** True when the chart's main series actually has bars loaded. */
async function hasBars() {
  return evaluate(`
    (function() {
      try {
        var b = ${KNOWN_PATHS.mainSeriesBars};
        return !!(b && typeof b.lastIndex === 'function' && b.lastIndex() >= 0);
      } catch(e) { return false; }
    })()
  `);
}

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

export async function start({ date } = {}) {
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);
  await new Promise(r => setTimeout(r, 500));

  if (date) await evaluate(`${rp}.selectDate(new Date('${date}'))`);
  else await evaluate(`${rp}.selectFirstAvailableDate()`);
  await new Promise(r => setTimeout(r, 1000));

  // Check for "Data point unavailable" toast which corrupts the chart
  const toast = await evaluate(`
    (function() {
      var toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="banner"]');
      for (var i = 0; i < toasts.length; i++) {
        var text = toasts[i].textContent || '';
        if (/data point unavailable|not available for playback/i.test(text)) return text.trim().substring(0, 200);
      }
      return null;
    })()
  `);

  if (toast) {
    // Stop replay to recover chart
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    throw new Error(`Replay date unavailable: "${toast}". The requested date has no data for this timeframe. Try a more recent date or switch to a higher timeframe (e.g., Daily).`);
  }

  // A date with no data for this symbol/timeframe leaves the chart with no bars
  // and every pane reading "This symbol doesn't exist". Once in that state the
  // feed cannot be recovered without reloading, so back out here instead.
  //
  // This is the common failure when no date is given: selectFirstAvailableDate()
  // can land decades before the symbol had data (e.g. 2011 on BITSTAMP:BTCUSD).
  if (!(await hasBars())) {
    try { await evaluate(`${rp}.stopReplay()`); } catch { /* best effort */ }
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch { /* best effort */ }
    throw new Error(
      `Replay produced no data for ${date ? `date ${date}` : 'the first available date'} on this symbol/timeframe. ` +
      'Backed out to protect the chart. Pass an explicit recent date, or switch to a higher timeframe. ' +
      'If the chart still shows no data, reload it to recover.',
    );
  }

  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, replay_started: !!started, date: date || '(first available)', current_date: currentDate };
}

export async function step() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  await evaluate(`${rp}.doStep()`);
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed } = {}) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

/**
 * Leave replay mode and return to realtime.
 *
 * stopReplay() is enough on a healthy chart, but silently fails when the chart
 * has been wedged — most often by entering replay at a date the symbol has no
 * data for. This used to report success regardless, leaving the chart stuck in
 * the past with no indication anything was wrong.
 *
 * Every step is now verified, escalating through the exit methods this build
 * exposes, and an exit that did not take is reported as a failure with the
 * recovery that does work.
 */
export async function stop() {
  const rp = await getReplayApi();

  const isStarted = () => evaluate(wv(`${rp}.isReplayStarted()`));
  const hideToolbar = async () => {
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch { /* already hidden */ }
  };

  if (!(await isStarted())) {
    await hideToolbar();
    return { success: true, action: 'already_stopped', replay_started: false };
  }

  // stopReplay() is the correct programmatic exit and works on any chart that
  // is not wedged. Retried briefly because the flag lags the call.
  //
  // leaveReplay() is deliberately NOT used: it is the toolbar's exit button and
  // opens a modal "Leave current replay?" confirmation, which blocks and leaves
  // the flag set until someone clicks it. goToRealtime() does not clear the flag
  // either. Neither belongs in a non-interactive stop.
  await evaluate(`${rp}.stopReplay()`);

  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 600));
    if (!(await isStarted())) {
      await hideToolbar();
      return { success: true, action: 'replay_stopped', replay_started: false };
    }
  }

  // Still in replay: the chart is wedged. Report it instead of claiming success.
  const currentDate = await evaluate(wv(`${rp}.currentDate()`)).catch(() => null);
  throw new Error(
    'Could not leave replay mode — stopReplay() ran but isReplayStarted() is still true' +
    (currentDate ? ` (chart is at ${new Date(currentDate * 1000).toISOString()})` : '') +
    '. This happens when replay was started at a date the symbol has no data for, which wedges the ' +
    'chart feed. Recover by reloading the chart: it comes back at realtime from the saved layout. ' +
    'Do not use leaveReplay() — it opens a confirmation dialog that needs a click.',
  );
}

export async function trade({ action }) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status() {
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
