/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, KNOWN_PATHS } from '../connection.js';

const PRICEALERTS = 'https://pricealerts.tradingview.com';

/**
 * Condition types accepted by the pricealerts API.
 * "cross" is what TradingView's own dialog sends for a price alert; the
 * directional variants are the same shape with a different type.
 */
const CONDITION_TYPES = {
  crossing: 'cross',
  cross: 'cross',
  crossing_up: 'cross_up',
  crossing_down: 'cross_down',
  greater_than: 'greater',
  less_than: 'less',
};

/**
 * Create a price alert through the same REST endpoint TradingView's own dialog
 * uses, captured by intercepting the UI.
 *
 * The previous implementation drove the alert dialog through the DOM. It broke
 * on two counts: it looked for [aria-label="Create Alert"] while the button is
 * labelled "Create alert" (and is also reachable as [data-name=set-alert-button]),
 * and even when the dialog opened, setting the price input's value did not reach
 * React's state — so the alert was created at whatever price was pre-filled,
 * not the requested one. Going through REST avoids both.
 *
 * Payload shape (from the captured request):
 *   {"payload": {conditions: [...], symbol, resolution, message, ...}}
 */
export async function create({ symbol, condition, price, message, resolution, expiration_days, notify } = {}) {
  const value = Number(price);
  if (!Number.isFinite(value)) throw new Error('price is required and must be a number.');

  const condKey = String(condition || 'crossing').toLowerCase();
  const condType = CONDITION_TYPES[condKey];
  if (!condType) {
    throw new Error(`Unknown condition "${condition}". Use one of: ${Object.keys(CONDITION_TYPES).join(', ')}.`);
  }

  const sym = symbol || await evaluate(`${KNOWN_PATHS.chartApi}.symbol()`);
  if (!sym) throw new Error('Could not determine the symbol. Pass symbol explicitly.');

  const res = String(resolution || '1');
  const days = Number(expiration_days ?? 30);
  const expiration = new Date(Date.now() + days * 86400000).toISOString();
  const n = notify || {};

  const payload = {
    conditions: [{
      type: condType,
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value }],
      resolution: res,
    }],
    // The leading "=" is required — TradingView encodes the symbol as an
    // "=" followed by a JSON blob. list() strips it on the way back in.
    // Without it the API rejects the request with a bare "internal".
    symbol: `=${JSON.stringify({ 'currency-id': 'USD', symbol: sym })}`,
    resolution: res,
    message: message || `${sym.replace(/^.*:/, '')} ${condKey.replace(/_/g, ' ')} ${value}`,
    sound_file: 'alert/beep_beep',
    sound_duration: 60,
    popup: n.popup !== false,
    auto_deactivate: true,
    email: !!n.email,
    sms_over_email: false,
    mobile_push: !!n.mobile_push,
    web_hook: n.web_hook || null,
    name: null,
    expiration,
    active: true,
    ignore_warnings: true,
  };

  const result = await evaluateAsync(`
    fetch(${JSON.stringify(`${PRICEALERTS}/create_alert`)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ payload: ${JSON.stringify(payload)} })
    })
      .then(function(r) { return r.text().then(function(t) {
        var parsed = null; try { parsed = JSON.parse(t); } catch (e) {}
        return { status: r.status, parsed: parsed, body: t.slice(0, 300) };
      }); })
      .catch(function(e) { return { err: e.message }; })
  `);

  if (result?.err) throw new Error(`Could not reach the alert API: ${result.err}`);
  if (result?.parsed?.s !== 'ok') {
    const code = result?.parsed?.err?.code || result?.parsed?.errmsg || result?.body;
    throw new Error(`Alert creation rejected by TradingView: ${code}`);
  }

  const created = result.parsed.r || {};
  return {
    success: true,
    alert_id: created.alert_id ?? null,
    symbol: sym,
    price: value,
    condition: condKey,
    resolution: res,
    message: payload.message,
    expiration,
    source: 'pricealerts_api',
  };
}

export async function createLegacyDom({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], '${price}');
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], '${price}');
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

/**
 * Delete alerts by id, or all of them.
 *
 * Previously this could only open a context menu and ask the user to finish the
 * job by hand, and deleting a single alert was unsupported — so the only
 * programmatic option was "remove everything", which is not something to do to
 * someone's alert list. Uses the same endpoint the UI's delete confirmation
 * sends.
 */
export async function deleteAlerts({ alert_ids, delete_all } = {}) {
  let ids = Array.isArray(alert_ids) ? alert_ids.map(Number).filter(Number.isFinite) : [];

  if (delete_all) {
    const current = await list();
    ids = (current.alerts || []).map((a) => a.alert_id).filter((x) => x != null);
    if (!ids.length) return { success: true, deleted: 0, note: 'No alerts to delete.' };
  }

  if (!ids.length) {
    throw new Error('Pass alert_ids (from alert_list) or delete_all: true. Deleting every alert is not the default for a reason.');
  }

  const result = await evaluateAsync(`
    fetch(${JSON.stringify(`${PRICEALERTS}/delete_alerts`)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } })
    })
      .then(function(r) { return r.text().then(function(t) {
        var parsed = null; try { parsed = JSON.parse(t); } catch (e) {}
        return { status: r.status, parsed: parsed, body: t.slice(0, 300) };
      }); })
      .catch(function(e) { return { err: e.message }; })
  `);

  if (result?.err) throw new Error(`Could not reach the alert API: ${result.err}`);
  if (result?.parsed?.s !== 'ok') {
    throw new Error(`Alert deletion rejected: ${result?.parsed?.err?.code || result?.parsed?.errmsg || result?.body}`);
  }

  // Clears any "fired while offline" markers left behind for these alerts,
  // which the UI does as a second call after deleting.
  try {
    await evaluateAsync(`
      fetch(${JSON.stringify(`${PRICEALERTS}/clear_offline_fires`)}, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } })
      }).then(function(r) { return r.status; }).catch(function() { return null; })
    `);
  } catch { /* cosmetic */ }

  return { success: true, deleted: ids.length, alert_ids: ids, source: 'pricealerts_api' };
}
