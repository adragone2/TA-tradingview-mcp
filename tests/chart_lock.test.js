import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockHolder, acquireChartLock, CHART_LOCK_PATH } from '../src/core/chart_lock.js';

/**
 * ONE process drives the chart.
 *
 * Two morning-screen runs two minutes apart interleaved their symbol switches and
 * each restored the chart to the OTHER run's working symbol; an interactive
 * analysis running alongside read three different companies' bars believing they
 * were one. A lock was added — to that one script only, which is why a
 * `level-primary-holdout.js` could sit resident for 157 minutes holding nothing.
 */

const tmp = () => {
  const d = join(tmpdir(), `chartlock-${process.pid}-${readdirSync(tmpdir()).length}`);
  mkdirSync(d, { recursive: true });
  return join(d, '.chart.lock');
};

describe('the lock file', () => {
  test('an unheld lock reports nobody', () => {
    assert.equal(lockHolder(tmp()), null);
  });

  test('a lock whose process is GONE is not a holder', () => {
    /**
     * A crash leaves the file behind. Respecting it would turn one past failure
     * into a permanent refusal to run — the daily job would never recover on its
     * own. `process.kill(pid, 0)` tests liveness without signalling.
     */
    const p = tmp();
    writeFileSync(p, JSON.stringify({ pid: 999999, label: 'crashed', started: 'yesterday' }));
    assert.equal(lockHolder(p), null, 'a dead pid must not hold the chart');
  });

  test('a LIVE holder is reported, with what it is', () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ pid: process.pid, label: 'sunday-review', started: 'now' }));
    assert.equal(lockHolder(p).label, 'sunday-review',
      'a conflict must name the other run — "something else is running" is not actionable');
  });

  test('a corrupt or missing file is not a holder', () => {
    const p = tmp();
    writeFileSync(p, 'not json at all');
    assert.equal(lockHolder(p), null);
  });
});

describe('acquiring', () => {
  test('taking it records pid, label and start time', () => {
    const p = tmp();
    const lock = acquireChartLock({ label: 'test-run', path: p });
    assert.equal(lock.acquired, true);
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.label, 'test-run');
    assert.ok(Date.parse(rec.started), 'started must be a parseable timestamp');
    lock.release();
    assert.equal(existsSync(p), false, 'release must remove our own record');
  });

  test('a conflict THROWS when asked to, naming the holder', () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ pid: process.pid, label: 'morning-screen', started: 'now' }));
    assert.throws(
      () => acquireChartLock({ label: 'second', path: p, on_conflict: 'throw' }),
      /morning-screen/,
      'a measurement script must report the refusal rather than exit 0 as if it had measured something',
    );
  });

  test('a stale lock is TAKEN, not respected', () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ pid: 999999, label: 'crashed-run', started: 'yesterday' }));
    const lock = acquireChartLock({ label: 'fresh', path: p, on_conflict: 'throw' });
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).label, 'fresh');
    lock.release();
  });

  test('release NEVER removes a lock another process took over', () => {
    /**
     * If our lock went stale and someone else took it, deleting the file on our way
     * out unlocks the chart under a live run — the failure the lock exists to
     * prevent, caused by the lock's own cleanup.
     */
    const p = tmp();
    const lock = acquireChartLock({ label: 'ours', path: p });
    writeFileSync(p, JSON.stringify({ pid: 999999, label: 'someone-else', started: 'now' }));
    lock.release();
    assert.equal(existsSync(p), true, 'another process owns this record now');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).label, 'someone-else');
    rmSync(p, { force: true });
  });

  test('release is idempotent', () => {
    const p = tmp();
    const lock = acquireChartLock({ label: 'x', path: p });
    lock.release();
    lock.release();
    assert.equal(existsSync(p), false);
  });
});

describe('every chart-driving entry point takes it', () => {
  /**
   * The lock lived in `morning-screen.js` alone, which is a lock in name only: the
   * Sunday review, clear-orphans and the six measurement scripts behind
   * `_real_bars.js` drive the same one chart.
   */
  const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

  for (const f of ['scripts/morning-screen.js', 'scripts/sunday-review.js', 'scripts/_real_bars.js']) {
    test(`${f} acquires the chart lock`, () => {
      assert.match(src(f), /acquireChartLock\(/,
        `${f} walks the chart symbol by symbol and must exclude the others`);
    });
  }

  test('clear-orphans takes it only when it will WRITE', () => {
    // Its default is a read-only dry run, and blocking that behind a lock held by a
    // legitimate long run makes the diagnostic unavailable exactly when it is needed.
    assert.match(src('scripts/clear-orphans.js'), /if \(APPLY\) acquireChartLock\(/);
  });

  test('the path is FIXED, not derived from --out-dir', () => {
    /**
     * The old lock lived under the caller's output directory, so two runs invoked
     * with different `--out-dir` values each took their own and interleaved anyway —
     * mutual exclusion that evaporates precisely when someone is being careful
     * enough to separate their output.
     */
    assert.equal(CHART_LOCK_PATH, 'reports/.chart.lock');
    assert.ok(!src('scripts/morning-screen.js').includes("join(OUT_DIR, '.screen.lock')"),
      'the per-out-dir lock path must be gone');
  });

  test('_real_bars releases only AFTER restoring the chart', () => {
    const s = src('scripts/_real_bars.js');
    const restore = s.indexOf('setTimeframe({ timeframe: String(restoreResolution)');
    const release = s.indexOf('lock.release()');
    assert.ok(restore > 0 && release > restore,
      'the restore is itself a chart write — releasing first lets another run start mid-restore');
  });
});
