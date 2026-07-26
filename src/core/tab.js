/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, setPreferredTarget, getTargetInfo } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Try to open a new chart tab.
 *
 * The tab strip is Electron application chrome, not part of the page, so CDP
 * input goes to the web contents and never reaches it. Target.createTarget is
 * rejected as "Not supported" by this build, and there is no DOM control to
 * click. The keyboard shortcut is attempted because it works on some builds,
 * but the result is verified and a failure is reported rather than dressed up
 * as success — the previous version always returned success while leaving the
 * tab count unchanged.
 */
export async function newTab() {
  const before = await list();
  const c = await getClient();

  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: mod, key: 't', code: 'KeyT' });

  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 400));
    const now = await list();
    if (now.tab_count > before.tab_count) {
      return { success: true, action: 'new_tab_opened', tabs_before: before.tab_count, ...now };
    }
  }

  throw new Error(
    `Could not open a new tab — the count stayed at ${before.tab_count}. ` +
    'On TradingView Desktop the tab strip is application chrome, so CDP keyboard input does not reach it ' +
    'and Target.createTarget is unsupported. Open the tab manually (the + button next to the tab strip), ' +
    'then use tab_list and tab_switch.',
  );
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  // The closed tab may have been the pinned one. Unpin so the next call
  // auto-selects a live target instead of chasing a target that is gone.
  await setPreferredTarget(null);

  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 400));
    const after = await list();
    if (after.tab_count < before.tab_count) {
      return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
    }
  }

  throw new Error(
    `Could not close the tab — the count stayed at ${before.tab_count}. ` +
    'The tab strip is application chrome on TradingView Desktop, so CDP keyboard input does not reach it. ' +
    'Close the tab manually.',
  );
}

/**
 * Switch to a tab by index, and rebind CDP to it.
 *
 * Bringing a tab to front does NOT move an existing CDP session. Previously
 * this only called /json/activate, so the tab changed on screen while every
 * subsequent read and write still went to the old tab — chart_get_state would
 * describe one chart while the user was looking at another.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`Tab index must be a non-negative integer, got ${index}.`);
  }
  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tab${tabs.tab_count === 1 ? '' : 's'}).`);
  }

  const target = tabs.tabs[idx];

  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }

  // Rebind, then confirm we are actually talking to the tab we switched to.
  await setPreferredTarget(target.id);

  let bound = null;
  try {
    await getClient();
    bound = await getTargetInfo();
  } catch (e) {
    throw new Error(`Activated tab ${idx} but could not attach CDP to it: ${e.message}`);
  }

  if (bound?.id !== target.id) {
    throw new Error(`Activated tab ${idx} but CDP bound to a different target (${bound?.id}). The tab may have closed.`);
  }

  return {
    success: true,
    action: 'switched',
    index: idx,
    tab_id: target.id,
    chart_id: target.chart_id,
    url: target.url,
    cdp_rebound: true,
  };
}
