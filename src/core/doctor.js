/**
 * Preflight diagnostics.
 *
 * Collapses the whole manual setup checklist — node version, TradingView
 * install, port 9222, MCP server load, live CDP read, rules.json — into one
 * pass. Every failing check carries a `fix` string: the exact command to run
 * next, resolved for the current platform.
 *
 * Runs entirely over the CLI so it works BEFORE the Claude restart that loads
 * the MCP tools.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findTradingViewBinary } from "./health.js";
import { rulesStatus } from "./rules.js";
import { checkServerCurrent } from "./tool_registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SERVER_ENTRY = join(PROJECT_ROOT, "src", "server.js");

const MIN_NODE_MAJOR = 18;
const CDP_HOST = "localhost";

function check(name, ok, detail, fix = null) {
  return fix && !ok ? { name, ok, detail, fix } : { name, ok, detail };
}

async function getJson(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Platform-appropriate command to start TradingView with CDP enabled. */
function launchHint(port) {
  if (process.platform === "win32") return `node src/cli/index.js launch --port ${port}`;
  return `node src/cli/index.js launch --port ${port}   (or: open -a TradingView --args --remote-debugging-port=${port})`;
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return check(
    "node_version",
    major >= MIN_NODE_MAJOR,
    `node v${process.versions.node}`,
    `Node ${MIN_NODE_MAJOR}+ required. Install a newer Node and re-run.`,
  );
}

/**
 * The point of locating the binary is to be able to launch it. When TradingView
 * is already running and answering on CDP, a failed lookup is a limitation
 * (tv_launch won't work) — not a reason to tell the user to install an app they
 * are demonstrably running.
 */
function checkTradingViewInstalled({ cdpReachable }) {
  const { path, platform, candidates, install_type } = findTradingViewBinary();

  if (path) {
    return check("tradingview_installed", true, install_type === "microsoft_store" ? `${path} (Microsoft Store install)` : path);
  }

  if (cdpReachable) {
    return {
      name: "tradingview_installed",
      ok: true,
      detail: `binary not located on ${platform}, but TradingView is running and answering on CDP`,
      advice: "tv_launch cannot start TradingView automatically on this machine — launch it yourself with --remote-debugging-port.",
    };
  }

  return check(
    "tradingview_installed",
    false,
    `not found on ${platform}`,
    `TradingView Desktop not found. Searched: ${candidates.join(", ")}${platform === "win32" ? ", and Microsoft Store packages" : ""}. Install from tradingview.com/desktop`,
  );
}

function checkServerEntry() {
  return check(
    "server_entry",
    existsSync(SERVER_ENTRY),
    SERVER_ENTRY,
    `Missing ${SERVER_ENTRY}. Did the clone or npm install fail? Re-run: npm install`,
  );
}

/**
 * Start the MCP server with no stdin and confirm the startup banner reaches
 * stderr. Catches load-time crashes that would otherwise show up only as a
 * silently missing server inside Claude.
 */
function checkServerLoads(timeoutMs = 6000) {
  return new Promise((resolvePromise) => {
    if (!existsSync(SERVER_ENTRY)) {
      return resolvePromise(
        check("mcp_server_loads", false, "server.js missing — skipped", "Re-run: npm install"),
      );
    }

    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });

    const finish = (ok, detail, fix) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolvePromise(check("mcp_server_loads", ok, detail, fix));
    };

    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (/tradingview-mcp/i.test(stderr)) {
        finish(true, "server started and emitted its banner");
      }
    });

    child.on("error", (err) => {
      finish(false, `could not spawn: ${err.message}`, "Check that node is on PATH and npm install completed.");
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${code}`;
        finish(false, `server exited early (code ${code}): ${tail}`, "Fix the error above, then re-run. It will fail inside Claude the same way.");
      } else {
        finish(false, "server exited without emitting its banner", "Re-run: npm install");
      }
    });

    const timer = setTimeout(() => {
      const tail = stderr.trim().split("\n").slice(-6).join("\n");
      finish(false, `no banner within ${timeoutMs}ms${tail ? `: ${tail}` : ""}`, "Re-run: npm install");
    }, timeoutMs);
  });
}

async function checkCdp(port) {
  const { data, error } = await getJson(`http://${CDP_HOST}:${port}/json/version`);
  if (error) {
    return {
      result: check(
        "cdp_port",
        false,
        `nothing answering on ${CDP_HOST}:${port} (${error})`,
        `TradingView is not running with CDP enabled. Start it with: ${launchHint(port)}`,
      ),
      reachable: false,
    };
  }
  return {
    result: check("cdp_port", true, `${data.Browser || "connected"} on port ${port}`),
    reachable: true,
  };
}

async function checkChartTarget(port) {
  const { data, error } = await getJson(`http://${CDP_HOST}:${port}/json/list`);
  if (error) {
    return check("chart_target", false, `could not list targets: ${error}`, `Restart TradingView with: ${launchHint(port)}`);
  }
  const pages = (data || []).filter((t) => t.type === "page");
  const chart = pages.find((t) => /tradingview\.com\/chart/i.test(t.url)) || pages.find((t) => /tradingview/i.test(t.url));
  return check(
    "chart_target",
    !!chart,
    chart ? chart.url : `no TradingView chart among ${pages.length} page target(s)`,
    "TradingView is running but no chart is open. Open a chart tab, then re-run.",
  );
}

async function checkLiveRead() {
  // Imported lazily so a CDP-less run never pays the connection cost.
  const { healthCheck } = await import("./health.js");
  try {
    const h = await healthCheck();
    if (!h.api_available) {
      return check(
        "live_read",
        false,
        "connected, but the chart API is not exposed yet",
        "TradingView is still loading. Wait a few seconds and re-run.",
      );
    }
    return check("live_read", true, `${h.chart_symbol} @ ${h.chart_resolution}`);
  } catch (err) {
    return check("live_read", false, err.message, "Confirm a chart is open, then re-run.");
  }
}

function checkRules() {
  const r = rulesStatus();
  // Absent rules.json is no longer fatal — morning_brief falls back to the
  // live watchlist — so this is advisory, not a failure.
  return {
    name: "rules_json",
    ok: true,
    detail: r.found ? r.path : "not present — morning_brief will use built-in defaults + your live watchlist",
    advice: r.found ? null : 'Run "tv rules init" to create an editable rules.json.',
  };
}

export async function doctor({ port = 9222, skip_server_test = false } = {}) {
  // CDP is probed first so the install check can tell "not installed" from
  // "installed somewhere we can't see, but already running".
  const { result: cdpResult, reachable } = await checkCdp(port);

  const checks = [checkNode(), checkTradingViewInstalled({ cdpReachable: reachable }), checkServerEntry()];

  if (!skip_server_test) {
    checks.push(await checkServerLoads());
  }

  checks.push(cdpResult);

  if (reachable) {
    const target = await checkChartTarget(port);
    checks.push(target);
    if (target.ok) checks.push(await checkLiveRead());
  }

  checks.push(checkRules());
  /**
   * Last, but it explains failures the others cannot: a tool that exists in source
   * and is missing from this process means the server is running older code, and
   * every other check will pass while it does.
   */
  checks.push(checkServerCurrent());

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;

  return {
    success: true,
    ok,
    platform: process.platform,
    cdp_port: port,
    checks,
    failed_count: failed.length,
    summary: ok
      ? `All ${checks.length} checks passed — the bridge is live.`
      : `${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.name).join(", ")}`,
    next: ok
      ? "Setup is complete. Fully quit Claude (Cmd-Q / Alt-F4) and reopen it so the MCP tools load."
      : failed[0].fix || "See the failing check above.",
  };
}
