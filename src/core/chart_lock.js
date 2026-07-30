/**
 * ONE process may drive the chart at a time.
 *
 * ── Why this is a module and not three copies of a snippet ──
 *
 * There is exactly one TradingView chart, and every script here walks it symbol by
 * symbol. Two morning-screen instances started two minutes apart on 2026-07-30 and
 * interleaved their writes: each captured the "original" symbol from a chart the
 * other had already moved, so the restore at the end put it back to the *other*
 * run's working symbol. The damage was not confined to those two — an interactive
 * analysis running at the same time read `BATS:AMLX`, then `BATS:EVRG`, then
 * `BATS:ZGN` while believing it was reading one symbol.
 *
 * A lock was added to `morning-screen.js` and it worked. It was also the ONLY
 * holder, which is a lock in name only: `sunday-review.js`, `clear-orphans.js` and
 * the six measurement scripts that go through `_real_bars.js` all drive the same
 * chart and none of them announced themselves. That was not theoretical — a
 * `level-primary-holdout.js` was found still resident 157 minutes after its results
 * had been recorded, on 0.6 seconds of CPU, holding no lock and able to move the
 * chart out from under anything the moment it woke.
 *
 * ── Two decisions worth stating ──
 *
 * The path is FIXED, not derived from `--out-dir`. The old lock lived under the
 * caller's output directory, so two runs invoked with different `--out-dir` values
 * would each take their own lock and happily interleave — mutual exclusion that
 * evaporates exactly when someone is being careful enough to separate their output.
 *
 * A stale lock is TAKEN, not respected. `process.kill(pid, 0)` tests liveness
 * without signalling; a lock whose process is gone is a crash artifact, and
 * refusing to run because of one turns a past failure into a permanent one.
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** Fixed on purpose — see the header. */
export const CHART_LOCK_PATH = 'reports/.chart.lock';

/** The live holder, or null. A recorded pid whose process is gone is not a holder. */
export function lockHolder(path = CHART_LOCK_PATH) {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    try { process.kill(rec.pid, 0); return rec; } catch { return null; }
  } catch { return null; }
}

/**
 * Take the chart lock, or report who holds it.
 *
 * @param {string} label     What is running, so a conflict names something useful.
 * @param {string} on_conflict  'exit' (default, for scripts) or 'throw'.
 * @returns {{acquired: boolean, holder: object|null, release: function}}
 */
export function acquireChartLock({ label = 'unnamed', path = CHART_LOCK_PATH, on_conflict = 'exit' } = {}) {
  const held = lockHolder(path);
  if (held) {
    const msg = `Another process is already driving the chart: ${held.label} `
      + `(pid ${held.pid}, started ${held.started}). Exiting rather than interleaving chart writes with it. `
      + `If that process is wedged, kill it and re-run — a lock whose process is gone is taken automatically.`;
    if (on_conflict === 'throw') throw new Error(msg);
    console.log(msg);
    process.exit(0);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, label, started: new Date().toISOString() }));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only remove OUR record. A lock we lost to a takeover belongs to someone else,
    // and deleting it on the way out would unlock the chart under a live run.
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8'));
      if (rec.pid === process.pid) rmSync(path, { force: true });
    } catch { /* already gone */ }
  };

  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { release(); process.exit(1); });
  }
  return { acquired: true, holder: null, release };
}
