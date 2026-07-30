/**
 * Is the RUNNING server the code that is on disk?
 *
 * This exists because of a failure with no symptom until something breaks oddly.
 * Two tools — `chart_indicators_for_strategy` and `position_size_constrained` —
 * were written, registered, unit-tested and committed, and calling one returned
 * "No such tool available". Nothing was wrong with them. The MCP server process had
 * been started before they were added, so it was serving an older module graph, and
 * there was no way to ask it that question. Worse, `ticker_playbook` from the SAME
 * FILE worked, because it predated the restart — which makes "the file is stale"
 * look impossible and sends you hunting for a registration bug that is not there.
 *
 * An MCP server loads its tool modules once, at startup. Editing a tool file changes
 * nothing until the process restarts. That is ordinary, but it is invisible, and
 * invisible is what makes it cost an hour.
 *
 * Two independent detectors, because each is blind to what the other catches:
 *
 *   1. TOOL DIFF — scan `src/tools/*.js` for `server.tool('name'` and compare to the
 *      names the live process actually registered. Names the exact missing tools.
 *      Blind to edits that do not add or remove a tool.
 *   2. MTIME — compare the newest file under `src/` to when this process started.
 *      Catches behaviour-only edits, which the tool diff cannot see by construction.
 *
 * Both are heuristics about the process, not proof about its behaviour. Neither can
 * tell you the loaded code is CORRECT — only that it is, or is not, the same age as
 * the source.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..');
const TOOLS_DIR = path.join(SRC_DIR, 'tools');

/** Names the live process registered, filled in by recordRegistrations(). */
const registered = new Set();

/**
 * Wrap `server.tool` so every registration is recorded. Call ONCE, before any
 * register*Tools() call, or the registry undercounts and the check cries stale.
 */
export function recordRegistrations(server) {
  const original = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    registered.add(String(name));
    return original(name, ...rest);
  };
  return registered;
}

/** Tool names the live process registered. */
export function registeredTools() {
  return [...registered].sort();
}

/**
 * Tool names present in `src/tools/*.js` right now.
 *
 * Matches `server.tool('name'` across the newline the registrations are written
 * with. This is a text scan on purpose — importing the modules to ask them would
 * load the CURRENT code into this process, which is the very thing being tested.
 */
export function sourceTools({ dir = TOOLS_DIR } = {}) {
  const names = new Set();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  } catch {
    return { names: [], readable: false, dir };
  }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/server\.tool\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      names.add(m[1]);
    }
  }
  return { names: [...names].sort(), readable: true, dir, files: files.length };
}

/** Newest mtime under `src/`, and which file it was. */
export function newestSourceMtime({ dir = SRC_DIR } = {}) {
  let newest = 0;
  let file = null;
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.js')) continue;
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) { newest = mtimeMs; file = full; }
      } catch { /* unreadable file cannot make the server stale */ }
    }
  };
  walk(dir);
  return { newest_ms: newest, file };
}

/** When this process started, in epoch ms. */
export function processStartedMs() {
  return Date.now() - (process.uptime() * 1000);
}

/**
 * The diff itself, pure, so it can be tested without a live server or a clock.
 *
 * `ok` is false only when a tool exists in source but not in the live registry —
 * that is unambiguous and actionable. A newer mtime alone is reported as advice,
 * because it is true and harmless in the ordinary case where a file was touched
 * without changing behaviour.
 */
export function staleness({
  live = [], source = { names: [], readable: true, dir: TOOLS_DIR },
  startedMs = 0, newestMs = 0, newestFile = null, relativeTo = SRC_DIR,
} = {}) {
  const src = source;

  if (!src.readable) {
    return {
      name: 'server_current',
      ok: true,
      detail: `Could not read ${src.dir} to compare — skipped.`,
      advice: 'This check only works when run from a source checkout.',
    };
  }
  if (live.length === 0) {
    return {
      name: 'server_current',
      ok: true,
      detail: 'No registrations recorded — recordRegistrations() was not installed before the '
        + 'register*Tools() calls, so there is nothing to compare.',
      advice: 'Call recordRegistrations(server) in src/server.js before registering tools.',
    };
  }

  const liveSet = new Set(live);
  const missing = src.names.filter((n) => !liveSet.has(n));
  const extra = live.filter((n) => !src.names.includes(n));

  const sourceIsNewer = newestMs > startedMs;
  const minutesBehind = sourceIsNewer ? Math.round((newestMs - startedMs) / 60000) : 0;
  const rel = (f) => (f ? path.relative(relativeTo, f) : null);

  if (missing.length) {
    return {
      name: 'server_current',
      ok: false,
      detail: `The running server is STALE. ${missing.length} tool(s) exist in src/tools/ but were `
        + `never registered by this process: ${missing.join(', ')}. `
        + 'An MCP server loads its tool modules once at startup, so tools added since then are '
        + 'invisible and calling one returns "No such tool available" — even when other tools from '
        + 'the same file work, because those predate the restart.',
      fix: 'Restart the MCP server: fully quit Claude (Cmd-Q / Alt-F4) and reopen it, or restart '
        + 'the tradingview MCP server from your MCP client.',
      missing_tools: missing,
      registered_count: live.length,
      source_count: src.names.length,
      ...(extra.length ? {
        extra_tools: extra,
        extra_note: 'Registered but not found in source — usually a tool registered outside '
          + 'src/tools/, not a problem.',
      } : {}),
    };
  }

  return {
    name: 'server_current',
    ok: true,
    detail: `All ${src.names.length} tools in src/tools/ are registered in this process.`
      + (sourceIsNewer
        ? ` But source under src/ was modified ${minutesBehind} minute(s) AFTER this process started`
          + ` (newest: ${rel(newestFile)}). The tool LIST matches, so this`
          + ' check cannot tell whether the loaded behaviour does.'
        : ''),
    ...(sourceIsNewer ? {
      advice: 'Restart the MCP server if you have edited tool behaviour since it started. A tool-list '
        + 'comparison is blind to an edit that changes what a tool DOES without adding or removing one.',
      source_newer_than_process: true,
      newest_source_file: rel(newestFile),
      minutes_newer: minutesBehind,
    } : { source_newer_than_process: false }),
    registered_count: live.length,
  };
}

/** Gather the live inputs and run the diff. This is what tv_doctor calls. */
export function checkServerCurrent() {
  const { newest_ms: newestMs, file: newestFile } = newestSourceMtime();
  return staleness({
    live: registeredTools(),
    source: sourceTools(),
    startedMs: processStartedMs(),
    newestMs,
    newestFile,
  });
}
