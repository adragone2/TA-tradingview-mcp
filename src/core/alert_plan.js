/**
 * Auto-alerts at confirmed pattern completion levels — OPT-IN, and off everywhere
 * by default.
 *
 * ── Why this is not like the rest of the drawer ──
 *
 * Everything else in `drawFindings` writes to a CHART, and every chart write is
 * reversible: `draw_clear` removes what the registry tracks, `removeOrphans`
 * removes what the registry lost, and a signature in `MCP_TEXT_SIGNATURES` makes a
 * label sweepable a session later. An ALERT has none of that. It is created through
 * TradingView's `pricealerts` REST API on the owner's live account, it can fire and
 * notify a phone, and **nothing in this toolchain sweeps it** — `draw_clear`,
 * `removeOrphans` and `drawing_registry` are drawing machinery and do not know
 * alerts exist. The only removal path is `alert_delete` with explicit ids that a
 * human read off `alert_list`.
 *
 * So a created alert is PERMANENT until someone deletes it by hand. It carries a
 * 30-day expiration and `auto_deactivate` after its first fire (see
 * `core/alerts.js`), which stops it firing forever — it does not remove the row.
 * That is why every layer here defaults to OFF, why the count per run is capped,
 * and why every message carries `[MCP]`: the prefix is the whole cleanup story.
 * `alert_list` and filter on it is how you find them again.
 *
 * ── Why the decision is a pure planner ──
 *
 * The P2.4 review found a source-text contract passing while the behaviour was
 * dead: a neutered `if (false && ...)` satisfied every regex and killed the gate.
 * A rule that decides whether to touch a live account cannot be guarded that way.
 * `alertPlan` is pure — patterns, a spot price and the existing alert list in, a
 * create/skip decision out — so every clause is pinned by a CALL. `autoAlerts`
 * wraps it and does the two impure things (list, create), both injectable, so the
 * wiring is testable without an account.
 */
import * as alerts from './alerts.js';

const r2 = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
/** `Number(null)` is 0 and 0 is finite — the conversion that has bitten this repo four times. */
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * The prefix every auto-created alert message starts with.
 *
 * Not decoration. There is no registry and no sweep for alerts, so this string is
 * the only thing that distinguishes one this toolchain made from one the owner set
 * by hand — which matters at deletion time, when the two must not be confused.
 * Append-only, exactly like `MCP_TEXT_SIGNATURES`: change it and every alert
 * already on the account becomes unattributable.
 */
export const ALERT_PREFIX = '[MCP]';

export const ALERT_DEFAULTS = Object.freeze({
  /**
   * At most three per run. A pattern set can hold six after `planPatternDrawings`,
   * and six real notifications from one analysis is a pager, not a signal. The cap
   * is also the blast radius if anything below is wrong.
   */
  max_per_run: 3,
  /**
   * How close an existing alert has to be to count as the same one. The caller
   * passes the ATR-scaled tolerance the drawer computed (see `mergeTolerance`);
   * this fallback is the old fixed rule, for a caller with no ATR.
   */
  dedupe_tolerance_pct: 0.4,
});

/** Bare ticker, for comparing an alert's symbol with the analysed one. */
const bare = (s) => String(s ?? '').split(':').pop().trim().toUpperCase();

/**
 * The message. Machine-parseable on purpose — `@ <price>` is how a later run reads
 * the level back out of an alert it created, since `alert_list` does not reliably
 * return the trigger price in a documented shape.
 */
export function alertMessage({ symbol, pattern, status, direction, price }, prefix = ALERT_PREFIX) {
  const verb = direction === 'bearish' ? 'breaks' : 'completes';
  return `${prefix} ${bare(symbol)} ${pattern} ${status} ${verb} @ ${price} - auto-alert`;
}

/** Did this toolchain create it? The only attribution that exists for an alert. */
export function isMcpAlert(message, prefix = ALERT_PREFIX) {
  return String(message ?? '').trim().startsWith(prefix);
}

/** `@ 24.5` out of a message we wrote. */
const PRICE_IN_MESSAGE = /@\s*(-?\d+(?:\.\d+)?)/;

/**
 * The trigger price of an EXISTING alert, or null.
 *
 * `alert_list` maps TradingView's own row through and its `condition` is that raw
 * blob, so the price is read defensively from every shape it has been seen in, then
 * from our own message format. A null here is UNKNOWN, not "no price" — the
 * distinction decides whether a dedupe miss is reported.
 */
export function existingAlertPrice(alert) {
  const direct = num(alert?.price);
  if (Number.isFinite(direct)) return direct;

  const c = alert?.condition;
  const series = Array.isArray(c?.series) ? c.series : Array.isArray(c) ? c : [];
  for (const s of series) {
    const v = num(s?.value);
    if (Number.isFinite(v)) return v;
  }
  const flat = num(c?.value);
  if (Number.isFinite(flat)) return flat;

  const m = String(alert?.message ?? '').match(PRICE_IN_MESSAGE);
  if (m) {
    const v = num(m[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Which confirmed completion levels deserve an alert, and which do not.
 *
 * PURE. Every refusal comes back in `skipped` with its reason — a pattern that
 * silently produced no alert is indistinguishable from one the caller never passed.
 *
 * The checks, in the order they are reported:
 *
 *   SYMBOL. Refuses outright without one. `alerts.create` falls back to "whatever
 *   the chart is showing", and the chart here is a SHARED resource a scan steals
 *   mid-analysis — this repo has vcp_check returning three other companies' numbers
 *   during one live run. An alert on the wrong symbol is a real notification about a
 *   stock nobody analysed.
 *
 *   CONFIRMED ONLY. A forming pattern's completion level is a hypothesis; an alert
 *   on it is a hypothesis with a notification attached. Same gate the trade-plan
 *   legs already use.
 *
 *   FRESH. `stale: true` (from `patternAgePlan`) or an age past `max_age_bars`.
 *   The caller passes `patternAgePlan().fresh`, and this checks it AGAIN rather
 *   than trusting the caller, because the cost of the caller being wrong is a live
 *   alert on a shape the market left three weeks ago.
 *
 *   VERDICT SIDE. Same rule and same shape as `planPatternDrawings`: a `bias`
 *   narrows to the matching direction, no bias filters nothing. A pattern with no
 *   direction at all is refused — direction decides which side of spot is correct,
 *   so without it there is no such thing as a correct alert.
 *
 *   THE CORRECT SIDE OF SPOT. A bullish completion level BELOW spot has already
 *   broken; an alert there fires immediately and says nothing. Strict inequality —
 *   a level exactly at spot is not a trigger, it is now.
 *
 *   NOT ALREADY THERE. Within `tolerance_pct` of an existing alert on the same
 *   symbol. Re-running an analysis is normal and must not stack duplicates on an
 *   account with no cleanup story.
 *
 *   THE CAP. Input order is preserved and the cap takes the front of it, so the
 *   ordering is the DRAWER's ranking (confirmed, then Bulkowski's meeting-target
 *   rate, then recency) rather than a second one invented here.
 */
export function alertPlan(patterns, spot, existing_alerts = [], {
  symbol = null,
  bias = null,
  tolerance_pct = ALERT_DEFAULTS.dedupe_tolerance_pct,
  max_per_run = ALERT_DEFAULTS.max_per_run,
  max_age_bars = null,
  prefix = ALERT_PREFIX,
} = {}) {
  const create = [];
  const skipped = [];
  const list = Array.isArray(patterns) ? patterns : [];
  const px = num(spot);
  const sym = bare(symbol);
  const tol = num(tolerance_pct) >= 0 ? num(tolerance_pct) : ALERT_DEFAULTS.dedupe_tolerance_pct;
  const cap = num(max_per_run) >= 0 ? num(max_per_run) : ALERT_DEFAULTS.max_per_run;
  const ageLimit = num(max_age_bars) >= 0 ? num(max_age_bars) : Infinity;

  const onSymbol = (existing_alerts || []).filter((x) => x && bare(x.symbol) === sym);
  const priced = onSymbol.map((x) => ({ alert: x, price: existingAlertPrice(x) }));
  const unreadable = priced.filter((x) => !Number.isFinite(x.price)).length;

  const base = {
    symbol: symbol ?? null,
    spot: r2(px, 4),
    tolerance_pct: tol,
    max_per_run: cap,
    max_age_bars: Number.isFinite(ageLimit) ? ageLimit : null,
    prefix,
    existing: {
      considered: (existing_alerts || []).length,
      on_symbol: onSymbol.length,
      mcp: onSymbol.filter((x) => isMcpAlert(x.message, prefix)).length,
      /**
       * Alerts on this symbol whose trigger price could not be read. Reported
       * rather than assumed clear: the dedupe below cannot see them, so a duplicate
       * is possible against one of these and the reader should know it. They do NOT
       * block creation — a hand-set alert on the same name would otherwise veto
       * every auto-alert forever.
       */
      unreadable,
    },
  };

  if (!sym) {
    return {
      ...base,
      create: [],
      skipped: list.map((p) => ({
        pattern: p?.pattern ?? null,
        why: 'no symbol was passed — alerts.create would fall back to whatever the chart is showing, and '
          + 'the chart is a shared resource another script can move mid-analysis',
      })),
      refused: 'no symbol',
    };
  }
  if (!Number.isFinite(px) || px <= 0) {
    return {
      ...base,
      create: [],
      skipped: list.map((p) => ({
        pattern: p?.pattern ?? null,
        why: `no usable spot price (${spot ?? 'null'}) — without it the correct SIDE of the market cannot `
          + 'be checked, and a backwards alert fires the moment it is created',
      })),
      refused: 'no spot price',
    };
  }

  const want = { BULLISH: 'bullish', BEARISH: 'bearish' }[String(bias || '').toUpperCase()] || null;

  for (const p of list) {
    const pattern = p?.pattern ?? null;
    const status = p?.status ?? null;
    const direction = p?.direction ?? null;
    const age = num(p?.bars_ago);
    const level = num(p?.completion_level);
    const entry = { pattern, status, direction };

    if (status !== 'confirmed') {
      skipped.push({
        ...entry,
        why: `status is "${status ?? 'unknown'}", not confirmed — a forming pattern's completion level is a `
          + 'hypothesis, and an alert on it is a hypothesis with a notification attached',
      });
      continue;
    }
    if (p?.stale === true || (Number.isFinite(age) && age > ageLimit)) {
      skipped.push({
        ...entry,
        bars_ago: Number.isFinite(age) ? age : null,
        why: `age-excluded (${Number.isFinite(age) ? `${age} bars ago` : 'flagged stale'}`
          + `${Number.isFinite(ageLimit) ? `, max ${ageLimit}` : ''}) — the market this pattern described has moved on`,
      });
      continue;
    }
    if (direction !== 'bullish' && direction !== 'bearish') {
      skipped.push({
        ...entry,
        why: `direction is "${direction ?? 'none'}" — direction decides which side of spot is the correct `
          + 'one, so without it there is no correct alert',
      });
      continue;
    }
    if (want && direction !== want) {
      skipped.push({ ...entry, why: `direction "${direction}" contradicts the ${bias} verdict` });
      continue;
    }
    if (!Number.isFinite(level)) {
      skipped.push({ ...entry, why: 'no completion level — there is no price to alert at' });
      continue;
    }

    const above = level > px;
    const correctSide = direction === 'bullish' ? above : level < px;
    if (!correctSide) {
      skipped.push({
        ...entry,
        price: r2(level, 4),
        why: `${direction} completion ${r2(level, 4)} is ${level === px ? 'AT' : above ? 'above' : 'below'} spot `
          + `${r2(px, 4)} — already through it, so the alert would fire immediately and report nothing`,
        already_through: true,
      });
      continue;
    }

    const dupe = priced.find((x) => Number.isFinite(x.price)
      && (x.price === r2(level, 4) || Math.abs((x.price - level) / level) * 100 <= tol));
    if (dupe) {
      skipped.push({
        ...entry,
        price: r2(level, 4),
        why: `an alert already exists at ${r2(dupe.price, 4)}, within ${tol}% — re-running an analysis must `
          + 'not stack duplicates on an account with no cleanup story',
        duplicate_of: dupe.alert?.alert_id ?? null,
      });
      continue;
    }

    if (create.length >= cap) {
      skipped.push({ ...entry, price: r2(level, 4), why: `the per-run cap of ${cap} was already reached` });
      continue;
    }

    const price = r2(level, 4);
    create.push({
      symbol,
      price,
      /**
       * DIRECTIONAL, not a plain cross. `crossing` fires either way, so a bullish
       * break level would also notify on a drift back down through it after the
       * fact. `alerts.create` maps these onto the API's `cross_up`/`cross_down`.
       */
      condition: direction === 'bullish' ? 'crossing_up' : 'crossing_down',
      message: alertMessage({ symbol, pattern, status, direction, price }, prefix),
      pattern,
      status,
      direction,
      bars_ago: Number.isFinite(age) ? age : null,
      spot: r2(px, 4),
      distance_pct: r2(((price - px) / px) * 100, 3),
    });
  }

  return { ...base, create, skipped };
}

/**
 * The execution wrapper: fetch what exists, plan, create.
 *
 * `list` and `create` are injected so the wiring is testable — the planner is pure,
 * but "does the wrapper actually respect the plan" is a behavioural question about
 * impure calls, and it is the one a source contract cannot answer.
 *
 * Three properties are load-bearing:
 *
 *   DEFAULT OFF, and off means NOTHING IS CALLED. Not "creates nothing" — with
 *   `enabled` false the account is not even read. That is the property a test can
 *   pin by asserting the injected functions were never invoked.
 *
 *   A FAILED LIST REFUSES THE WHOLE RUN. Without the existing alerts there is no
 *   dedupe, and every re-run would stack another set of permanent alerts. Unknown is
 *   not safe here, exactly as `prune` refuses an unknown symbol.
 *
 *   `success: true` IS NOT EVIDENCE. `alerts.create` returns `alert_id: null` when
 *   TradingView accepted the call and produced nothing — the same failure shape as
 *   `drawShape` returning success with no entity id, and as `manageIndicator`
 *   returning `success: false` without throwing. A create with no id is recorded as
 *   FAILED, because an alert nobody can identify is one nobody can delete.
 */
export async function autoAlerts({
  enabled = false,
  patterns = [],
  spot = null,
  symbol = null,
  bias = null,
  tolerance_pct = ALERT_DEFAULTS.dedupe_tolerance_pct,
  max_per_run = ALERT_DEFAULTS.max_per_run,
  max_age_bars = null,
  resolution = undefined,
  expiration_days = undefined,
  notify = undefined,
} = {}, { list, create } = {}) {
  if (!enabled) {
    return {
      enabled: false,
      created: [],
      failed: [],
      skipped: [],
      note: 'auto_alerts is OFF (the default). Nothing was read from the account and nothing was created. '
        + 'These are real alerts on the live account and there is no sweep for them — see alert_plan.js.',
    };
  }

  const listFn = list || alerts.list;
  const createFn = create || alerts.create;

  let existing = [];
  try {
    const r = await listFn();
    if (r && r.error) throw new Error(r.error);
    existing = r?.alerts || [];
  } catch (e) {
    return {
      enabled: true,
      created: [],
      failed: [],
      skipped: [{
        why: `alert_list failed (${e.message}) — refusing to create. Without the existing list there is no `
          + 'dedupe, and every re-run would stack another permanent alert on the account.',
      }],
      refused: 'alert_list unavailable',
    };
  }

  const plan = alertPlan(patterns, spot, existing, {
    symbol, bias, tolerance_pct, max_per_run, max_age_bars,
  });

  const created = [];
  const failed = [];
  for (const c of plan.create) {
    try {
      const res = await createFn({
        symbol: c.symbol,
        price: c.price,
        condition: c.condition,
        message: c.message,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(expiration_days !== undefined ? { expiration_days } : {}),
        ...(notify !== undefined ? { notify } : {}),
      });
      if (res?.alert_id == null) {
        failed.push({
          ...c,
          error: 'the create returned no alert_id — either it silently made nothing, or it is on the account '
            + 'and cannot be identified for deletion',
        });
        continue;
      }
      created.push({ ...c, alert_id: res.alert_id });
    } catch (e) {
      failed.push({ ...c, error: e.message });
    }
  }

  return {
    enabled: true,
    prefix: plan.prefix,
    planned: plan.create.length,
    created,
    failed,
    skipped: plan.skipped,
    existing: plan.existing,
    tolerance_pct: plan.tolerance_pct,
    max_per_run: plan.max_per_run,
    ...(plan.refused ? { refused: plan.refused } : {}),
    note: 'REAL alerts on the live account. Nothing in this toolchain deletes them — draw_clear and the '
      + `orphan sweep are drawing machinery. Find them with alert_list (message starts with "${plan.prefix}") `
      + 'and remove them with alert_delete. They expire in 30 days and deactivate after one fire; the row stays.',
  };
}
