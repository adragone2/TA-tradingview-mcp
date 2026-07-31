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
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join('scripts', 'finviz', 'finviz_screen.py');
/** Three paginated queries against a scraped site; 6 minutes is generous, not tight. */
const DEFAULT_TIMEOUT_MS = 360_000;

/**
 * Ask Finviz the two questions TradingView cannot, for a batch of tickers.
 *
 * @returns {{available: boolean, tickers: object, why: string|null}}
 *   `tickers[SYM].optionable_and_shortable` is true / false / null, and null is
 *   UNKNOWN — either the query failed or the name was never tested.
 */
export async function finvizConstraints(tickers, { timeout_ms = DEFAULT_TIMEOUT_MS, python = 'python' } = {}) {
  const list = [...new Set((tickers || []).map((t) => String(t).split(':').pop().toUpperCase()))];
  if (!list.length) return { available: false, tickers: {}, why: 'no tickers supplied' };

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      child = spawn(python, [SCRIPT, '--tickers', list.join(',')], { windowsHide: true });
    } catch (e) {
      return finish({ available: false, tickers: {}, why: `could not start python: ${e.message}` });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ available: false, tickers: {}, why: `timed out after ${timeout_ms}ms` });
    }, timeout_ms);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ available: false, tickers: {}, why: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return finish({ available: false, tickers: {}, why: `exit ${code}: ${err.slice(0, 300)}` });
      }
      try {
        // The script prints warnings to stderr, but a stray stdout line would still
        // break JSON.parse — so take from the first brace rather than trusting the
        // whole buffer.
        const parsed = JSON.parse(out.slice(out.indexOf('{')));
        return finish({ available: true, why: null, ...parsed });
      } catch (e) {
        return finish({ available: false, tickers: {}, why: `unparseable output: ${e.message}` });
      }
    });
  });
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
