/**
 * Finviz as a CONSTRAINT layer, not a screener.
 *
 * ── Why this is not a ninth screen ──
 *
 * The obvious move after reading a swing-trading workflow is to add its screen:
 * sector-first, price above the 20/50/200, relative volume over 1. Every one of
 * those inputs is already in TradingView's scanner, which is faster, has 3,771
 * fields and needs no scraping — and the trend-alignment clause is `stage_plan`,
 * forward-tested here at 33.5% against a 36.4% baseline over 198 events. A Finviz
 * screen would be a slower copy of screens we have, with a refuted clause welded on.
 *
 * What Finviz has that TradingView does not is not a way to FIND a candidate. It is
 * a reason to REJECT one:
 *
 *   Option/Short   A bearish setup on a name you cannot borrow is not a trade.
 *   Earnings BMO   A print "tomorrow before the open" lands inside tonight's hold;
 *                  our scanner has the DATE and cannot tell you that.
 *
 * So it sits where the liquidity filter and the earnings veto already sit.
 *
 * ── Failure is not a veto ──
 *
 * This shells out to Python and scrapes a third-party site. It will be down, slow,
 * or newly-broken sometimes — the parser was silently corrupting every ticker when
 * this was written. So a failure returns UNKNOWN and vetoes nothing. Removing a
 * candidate because a scrape failed would be inventing a reason, and this repo's
 * standing rule is that unknown is not a negative.
 *
 * A MISSING OR BROKEN INTERPRETER IS THE SAME KIND OF FAILURE as a timeout, and
 * degrades the same way. It used to spawn a bare `python`, which is a name, not a
 * program: absent on a machine where the interpreter is `python3`, and present but
 * useless on Windows where the Microsoft Store stub sits on PATH, prints an advert
 * and exits non-zero. Either way the run must report UNAVAILABLE and veto nothing —
 * never crash, and never quietly drop a candidate because a shell lookup missed.
 *
 * ── It is SLOW, and it is not on the chart's critical path ──
 *
 * `enrich` issues three paginated scrapes (tradable, liquidity-only, earnings this
 * week) SERIALLY inside one Python process, ~90s together. That serialisation is
 * the politeness posture stated in `scripts/finviz/finviz_screen.py`'s own "Rate
 * discipline" section and is left alone. What was wasteful was WHERE it sat: the
 * morning screen ran it after the detector gate, so 90s of scraping was 90s of the
 * pre-open window with the chart idle. It touches no chart and no TradingView
 * socket, so `beginConstraints` starts the whole batch early and the caller awaits
 * it where the answer is actually consumed.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join('scripts', 'finviz', 'finviz_screen.py');
/** Three paginated queries against a scraped site; 6 minutes is generous, not tight. */
const DEFAULT_TIMEOUT_MS = 360_000;

/**
 * Which interpreter to try, in order.
 *
 * Bare `python` still LEADS the chain: it is what runs here today and this must not
 * change behaviour on a machine where it already works. What it must stop doing is
 * being the only answer.
 *
 * An EXPLICIT setting is exclusive — `opts.python`, else `FINVIZ_PYTHON`, and
 * nothing else is tried. If a venv was configured and is wrong, the run says so
 * rather than quietly succeeding through some other interpreter: a scrape that ran
 * against a different package set than the one that was configured is a worse
 * outcome than an honest `unavailable`, because it looks like it worked.
 *
 * `FINVIZ_PYTHON` is NEVER split on whitespace. The common Windows value is
 * `C:\Program Files\Python312\python.exe`, and splitting it would look for a
 * program called `C:\Program`.
 *
 * @returns {{command: string, args: string[], source: string}[]}
 */
export function pythonCandidates({ python = null, env = process.env, platform = process.platform } = {}) {
  const explicit = String(python ?? env?.FINVIZ_PYTHON ?? '').trim();
  if (explicit) {
    return [{ command: explicit, args: [], source: python ? 'python option' : 'FINVIZ_PYTHON' }];
  }
  const chain = [
    { command: 'python', args: [], source: 'fallback' },
    { command: 'python3', args: [], source: 'fallback' },
  ];
  // The Windows launcher finds a real install even when neither NAME is on PATH,
  // and skips the Store stub.
  if (platform === 'win32') chain.push({ command: 'py', args: ['-3'], source: 'fallback' });
  return chain;
}

const label = (c) => [c.command, ...c.args].join(' ');

/**
 * Did this interpreter actually have the scraper?
 *
 * An interpreter WITHOUT `finvizfinance` is not a failure the Python reports as
 * one: the import sits under `except ImportError`, every query returns None, and
 * `enrich` exits 0 with well-formed JSON in which every answer is null. Measured
 * here — bare `python` has the package and `python3` does not, on the same box.
 *
 * So the fallback chain, left naive, would step from a broken `python` onto a
 * `python3` that answers NOTHING and call it success. `applyTradability` would then
 * print "Finviz answered for 20 name(s)" having answered for none: a success flag
 * over a tool that did nothing, which is the failure mode this repo has already
 * found eight times.
 *
 * The distinction that matters for the chain is WHY nothing came back. Missing
 * package means this interpreter is unusable and the next one is worth trying —
 * and it costs the site nothing, because that path makes no request at all. A
 * screener error means Python was fine and finviz.com was not; trying two more
 * interpreters would just scrape a failing site twice more, so that stops here.
 */
function packageMissing(parsed) {
  const notes = Object.values(parsed?.parse || {});
  if (!notes.length) return false;
  const answered = Object.values(parsed?.sizes || {}).some((v) => v != null);
  return !answered && notes.every((n) => /not installed/i.test(String(n)));
}

/**
 * One attempt with one interpreter.
 *
 * `ran` is the distinction the chain turns on: false means this interpreter never
 * executed our script (not on PATH, not executable, or the Store stub that exits
 * non-zero having printed nothing), so the next candidate is worth trying. True
 * means Python ran and the answer — good or bad — is final, so the chain stops
 * rather than scraping the site two more times to be told the same thing.
 */
function runOnce(cand, tickerArg, timeout_ms, signal) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve({ ...v, python: label(cand) }); } };

    let child;
    try {
      /**
       * `signal` is spread in only when there IS one. Node rejects an explicit
       * `signal: null` with ERR_INVALID_ARG_TYPE — so passing it unconditionally
       * made every direct call (the normal path, which has no controller) fail to
       * spawn and report `unavailable`, which is exactly the shape of failure this
       * module is designed to swallow. Caught by the deadline test, not by the
       * degradation tests, which pass either way.
       */
      child = spawn(cand.command, [...cand.args, SCRIPT, '--tickers', tickerArg], {
        windowsHide: true, ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // A synchronous throw is a bad spawn argument, not a bad site.
      return finish({ ran: false, why: `could not start ${label(cand)}: ${e.message}` });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      // A timeout means it RAN and hung. Retrying with another interpreter would
      // burn the remaining deadline and hit the site again for the same answer.
      finish({ ran: true, why: `timed out after ${timeout_ms}ms` });
    }, timeout_ms);

    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (signal?.aborted) return finish({ ran: true, why: `cancelled: ${signal.reason ?? 'aborted'}` });
      const missing = e.code === 'ENOENT' || e.code === 'EACCES';
      finish({ ran: !missing, why: `${label(cand)}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return finish({ ran: true, why: `cancelled: ${signal.reason ?? 'aborted'}` });
      if (code !== 0) {
        // Nothing on stdout and a non-zero exit is the Windows Store stub's exact
        // signature — it is on PATH, so ENOENT never fires, and it never runs us.
        return finish({
          ran: out.length > 0,
          why: `${label(cand)} exit ${code}: ${(err || '(no stderr)').slice(0, 300)}`,
        });
      }
      try {
        // The script prints warnings to stderr, but a stray stdout line would still
        // break JSON.parse — so take from the first brace rather than trusting the
        // whole buffer.
        const parsed = JSON.parse(out.slice(out.indexOf('{')));
        return finish({ ran: true, ok: true, parsed });
      } catch (e) {
        return finish({ ran: true, why: `unparseable output from ${label(cand)}: ${e.message}` });
      }
    });
  });
}

/**
 * Ask Finviz the two questions TradingView cannot, for a batch of tickers.
 *
 * NEVER REJECTS and never throws. Every failure — no interpreter, a non-zero exit,
 * a hang, unparseable output — resolves as `available: false`, which vetoes nothing
 * downstream. `timeout_ms` is a deadline for the WHOLE call, not per attempt, so
 * walking the interpreter chain cannot extend it.
 *
 * @returns {{available: boolean, tickers: object, why: string|null, python: string|null,
 *            attempts: {python: string, source: string, why: string}[]}}
 *   `tickers[SYM].optionable_and_shortable` is true / false / null, and null is
 *   UNKNOWN — either the query failed or the name was never tested.
 */
export async function finvizConstraints(tickers, {
  timeout_ms = DEFAULT_TIMEOUT_MS, python = null, env = process.env, platform = process.platform, signal = null,
  candidates: injected = null,
} = {}) {
  const list = [...new Set((tickers || []).map((t) => String(t).split(':').pop().toUpperCase()))];
  if (!list.length) return { available: false, tickers: {}, why: 'no tickers supplied', python: null, attempts: [] };

  /**
   * `candidates` is a TEST SEAM, in the same spirit as `loadBars` in
   * `gateAndSelect`. Walking the chain is the whole point of this function, and
   * the only other way to exercise it is a machine where the first interpreter is
   * broken — which is exactly the machine nobody runs the suite on.
   */
  const candidates = injected || pythonCandidates({ python, env, platform });
  const deadline = Date.now() + timeout_ms;
  const attempts = [];

  for (const cand of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      attempts.push({ python: label(cand), source: cand.source, why: 'deadline already spent' });
      break;
    }
    const r = await runOnce(cand, list.join(','), remaining, signal);
    if (r.ok && packageMissing(r.parsed)) {
      // Exit 0, valid JSON, every answer null. See `packageMissing`.
      attempts.push({
        python: r.python,
        source: cand.source,
        why: 'ran, but finvizfinance is not installed for it — pip install finvizfinance',
      });
      continue;
    }
    if (r.ok) {
      return { available: true, why: null, python: r.python, attempts, ...r.parsed };
    }
    attempts.push({ python: r.python, source: cand.source, why: r.why });
    // It ran and gave a definite answer, or we were cancelled — stop here.
    if (r.ran || signal?.aborted) break;
  }

  const tried = attempts.map((a) => a.python).join(', ');
  const last = attempts.at(-1)?.why || 'no interpreter attempted';
  return {
    available: false,
    tickers: {},
    python: null,
    attempts,
    why: attempts.length > 1 ? `no usable python (tried ${tried}) — ${last}` : last,
  };
}

/**
 * Start the scrape NOW and hand back a handle to await later.
 *
 * The whole point is that nothing between the start and the await pays for it. The
 * morning screen starts this the moment the scanners have named their pre-gate
 * candidates and awaits it after the detector gate, which drives the chart for
 * minutes — so the ~90s of scraping happens inside a window that was going to be
 * spent anyway. This is only safe because the scrape touches NO chart and no
 * TradingView socket: it is a Python process talking to finviz.com.
 *
 * The resolved value is the `finvizConstraints` result plus `started_at`,
 * `finished_at` and `duration_ms`, so the caller can report what the overlap
 * actually hid rather than asserting it.
 *
 * `cancel()` kills the child. Needed for the case where the gate rejects
 * everything: with no candidates there is nothing to constrain, and waiting 90s
 * for an answer about an empty list is the same waste in a different place.
 *
 * @param {string[]} tickers A SUPERSET of whatever may survive the gate.
 * @param {{run?: Function}} opts `run` is injected by the tests; everything else
 *   is forwarded to `finvizConstraints`.
 */
export function beginConstraints(tickers, { run = finvizConstraints, ...opts } = {}) {
  const requested = [...new Set((tickers || []).map((t) => String(t).split(':').pop().toUpperCase()))];
  const started_at = Date.now();
  const controller = new AbortController();

  /**
   * Starting early widened the child's lifetime from "the length of one await" to
   * "several minutes of chart work", so a crash in between now leaks a live Python
   * process. The `exit` handler is synchronous and `AbortSignal` kills the child
   * synchronously, so this is enough — and it is removed the moment the scrape
   * settles, which is why it does not pile up across calls.
   */
  const killOnExit = () => controller.abort('the parent process is exiting');
  process.once('exit', killOnExit);

  const promise = (async () => {
    let result;
    try {
      // A `run` that throws synchronously must degrade like everything else, so the
      // call sits inside the try rather than before it.
      result = await run(tickers, { ...opts, signal: controller.signal });
    } catch (e) {
      result = { available: false, tickers: {}, why: `scrape threw: ${e?.message || e}`, python: null, attempts: [] };
    }
    process.removeListener('exit', killOnExit);
    const finished_at = Date.now();
    return { ...result, started_at, finished_at, duration_ms: finished_at - started_at };
  })();

  return {
    requested,
    started_at,
    promise,
    cancel(why = 'no longer needed') { controller.abort(why); },
  };
}

/**
 * Apply the constraint, DIRECTION-AWARE.
 *
 * Shortability only binds on a candidate we would SHORT. Vetoing a bullish name for
 * being hard to borrow would discard a perfectly good long, so the bias decides
 * whether the constraint applies at all.
 *
 * A veto requires a definite `false`. `null` — the query failed, or the name sits
 * below the liquidity bar the query used and was never tested — vetoes nothing.
 *
 * @param {object[]} candidates Each needs `symbol` and a bias (BULLISH/BEARISH/NEUTRAL).
 * @returns {{kept: object[], vetoed: object[], flagged: object[], note: string}}
 */
export function applyTradability(candidates, constraints) {
  const kept = [];
  const vetoed = [];
  const flagged = [];

  for (const c of candidates || []) {
    const sym = String(c.symbol || '').split(':').pop().toUpperCase();
    const info = constraints?.tickers?.[sym] || null;
    const bias = String(c.bias || c.stage2?.bias || '').toUpperCase();
    const shortable = info?.optionable_and_shortable ?? null;

    if (bias === 'BEARISH' && shortable === false) {
      vetoed.push({
        symbol: c.symbol,
        why: 'our read is BEARISH and Finviz reports it is not optionable-and-shortable — '
          + `no borrow means no trade. ${info?.basis || ''}`.trim(),
      });
      continue;
    }
    if (shortable === false) {
      // Not a veto: a long does not need a borrow. Worth carrying so a later
      // bearish re-read does not have to rediscover it.
      flagged.push({ symbol: c.symbol, why: 'not optionable-and-shortable — a SHORT here would not be executable' });
    }
    if (info?.reports_this_week) {
      flagged.push({ symbol: c.symbol, why: 'reports this week — check BMO/AMC against the intended hold' });
    }
    kept.push(c);
  }

  return {
    kept,
    vetoed,
    flagged,
    note: constraints?.available
      ? `Finviz answered for ${Object.keys(constraints.tickers || {}).length} name(s). A veto needs a `
        + 'definite false; unknown vetoes nothing.'
      : `Finviz UNAVAILABLE (${constraints?.why || 'unknown'}) — nothing was vetoed. A failed scrape `
        + 'is not evidence a name is untradeable.',
  };
}
