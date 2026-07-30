/**
 * FINRA short interest — the data behind Shannon's Chapter 15.
 *
 * Short interest is the one field in this toolchain that measures POSITIONING
 * rather than price: how many shares are sold short and not yet covered. Every
 * short is future demand, because it must eventually be bought back. That is
 * the whole reason it is worth having.
 *
 * It is NOT a signal. Shannon is explicit, and the caution is the load-bearing
 * part of the chapter:
 *
 *   "a large outstanding short position or short interest ratio BY ITSELF is
 *    not a reason for buying a stock in anticipation of a short squeeze ...
 *    Nonetheless, it is an excellent gauge of POTENTIAL DEMAND."
 *
 * So this module is shaped like ta_trading_context: a field you attach to a
 * setup you found some other way, never a screen that emits candidates.
 *
 * TWO THINGS THE RAW FEED GETS WRONG, both handled here:
 *
 *  1. FINRA FLOORS days-to-cover at 1.00. Its own metadata says "1.00 will be
 *     displayed for any values equal or less than 1". On 2026-07-15 AAPL had
 *     34,636,195 short against 38,275,532 ADV — a true 0.90 — reported as 1.
 *     We recompute from the two raw quantities and keep the reported figure
 *     beside ours so the clamp is visible rather than silently inherited.
 *
 *  2. DAYS-TO-COVER IS A RATIO AND MOVES WHEN ITS DENOMINATOR MOVES. In
 *     Shannon's own Figure 15.1 it falls from 12.91 to 4.11 in one period while
 *     the short position barely changes (19.28M -> 17.87M, -7%); the whole move
 *     is average volume tripling. Reading that as shorts capitulating is simply
 *     wrong. Every series here decomposes the change into its numerator and
 *     denominator contributions.
 *
 * Credentials come from FINRA_CLIENT_ID / FINRA_CLIENT_SECRET in the
 * environment or the git-ignored .env, never from a tool argument.
 *
 * Everything except the two network functions is pure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

const TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials';
const DATA_BASE = 'https://api.finra.org/data/group/otcMarket/name';
const DEFAULT_TIMEOUT_MS = 25000;

/**
 * Which dataset to ask.
 *
 * `consolidatedShortInterest` is the one that covers EXCHANGE-LISTED names —
 * "a single view of OTC short interest positions submissions across all
 * exchanges". `equityShortInterest` is OTC-only and returns HTTP 204 for a
 * listed symbol, which is easy to misread as "no short interest" rather than
 * "wrong dataset". Verified: PNC (NYSE) returns 204 from equityShortInterest
 * and 9 periods from consolidatedShortInterest.
 */
export const DATASETS = Object.freeze({
  consolidated: {
    name: 'consolidatedShortInterest',
    symbol_field: 'symbolCode',
    covers: 'All exchanges plus OTC — use this for listed equities.',
  },
  otc: {
    name: 'equityShortInterest',
    symbol_field: 'issueSymbolIdentifier',
    covers: 'OTC equity securities only. Returns HTTP 204 (empty) for a listed symbol.',
  },
});

/**
 * FINRA settles short interest twice a month and publishes on a lag, so the
 * newest figure is normally one to three weeks old. That is not a fault to
 * work around, it is the resolution of the measurement.
 */
export const REPORTING = Object.freeze({
  settlement_cadence: 'Twice monthly — mid-month and month-end settlement dates.',
  typical_publication_lag_days: 8,
  /** Beyond this, a scheduled report is probably missing rather than merely late. */
  stale_after_days: 25,
  source: 'FINRA Rule 4560. Shannon, ch. 15: "publicly disseminate the information on the 15th and last calendar day of each month."',
});

/**
 * Measured: how often is a big move in days-to-cover a change in LIQUIDITY
 * rather than in short positioning?
 *
 * Almost always. `node scripts/short-interest-driver.js` re-measures.
 *
 * This is the number that justifies the decomposition existing. Days-to-cover
 * is short interest divided by average volume, and on real data the DENOMINATOR
 * does nearly all the work — so the ratio is closer to a volume indicator than
 * to a positioning one. Every other detector in this repo carries its noise
 * floor; this is the same discipline applied to a ratio.
 */
export const DAYS_TO_COVER_DRIVER_STUDY = Object.freeze({
  measured_on: '2026-07-30',
  symbols: 40,
  period_changes: 1000,
  all_changes_driven_by_volume_pct: 79.4,
  big_move_threshold_pct: 20,
  big_moves: 458,
  big_moves_driven_by_volume: 426,
  big_moves_driven_by_volume_pct: 93.0,
  finding: '93% of days-to-cover moves of 20% or more were driven by a change in AVERAGE VOLUME, not by a change in '
    + 'the short position — 426 of 458, across 40 symbols spanning mega-caps to heavily-shorted small caps. On ten of '
    + 'those symbols (NVDA, AMZN, GOOGL, META, TSLA, PNC, BAC, PFE, MRK, CYTK) it was 100% of their big moves. '
    + 'Quoting days-to-cover alone therefore gets the story backwards most of the time it looks interesting.',
  worst_case: 'KSS, 2025-08-15: days-to-cover +351.5% while the short position moved +1.59%. Average volume fell 77.5%.',
  script: 'scripts/short-interest-driver.js',
});

/** Sentinels in `daysToCoverQuantity`, from FINRA's own field description. */
export const DTC_SENTINELS = Object.freeze({
  floor: 1.0,
  ceiling: 999.99,
  note: 'FINRA displays 1.00 for any true value at or below 1, and 999.99 as a ceiling. '
    + 'Both are clamps, not measurements — days_to_cover_computed is the honest figure.',
});

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

let envLoaded = false;

function readEnvFile(path) {
  if (!path || !existsSync(path)) return;
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return; }
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  readEnvFile(join(PROJECT_ROOT, '.env'));
  if (process.env.TA_ENV_FILE) readEnvFile(process.env.TA_ENV_FILE);
}

function credentials() {
  loadEnv();
  return {
    clientId: process.env.FINRA_CLIENT_ID || null,
    clientSecret: process.env.FINRA_CLIENT_SECRET || null,
  };
}

/** Config visibility without exposing either credential. */
export function apiStatus() {
  const { clientId, clientSecret } = credentials();
  const configured = !!(clientId && clientSecret);
  return {
    success: true,
    credentials_configured: configured,
    token_cached: !!(tokenCache.token && tokenCache.expiresAt > Date.now()),
    dataset: DATASETS.consolidated.name,
    reporting: REPORTING,
    ...(configured ? {} : {
      hint: 'Set FINRA_CLIENT_ID and FINRA_CLIENT_SECRET in .env at the project root (git-ignored). '
        + 'Never pass a credential as a tool argument.',
    }),
  };
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

/**
 * Tokens last ~12 hours, so caching one avoids an extra round trip on every
 * call. Refreshed a minute early rather than on expiry.
 */
const tokenCache = { token: null, expiresAt: 0 };

async function accessToken({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw new Error(
      'FINRA_CLIENT_ID and FINRA_CLIENT_SECRET are not both set. Add them to .env at the project root '
      + '(git-ignored). Do not paste a credential into a chat or a tool argument.',
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(`FINRA rejected the credentials (HTTP 401). Check FINRA_CLIENT_ID and FINRA_CLIENT_SECRET.`);
      }
      throw new Error(`FINRA token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const body = JSON.parse(text);
    if (!body.access_token) throw new Error('FINRA returned no access_token.');
    tokenCache.token = body.access_token;
    // Refresh a minute early so a long call cannot straddle expiry.
    tokenCache.expiresAt = Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000;
    return tokenCache.token;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`FINRA token request timed out after ${timeoutMs}ms.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch short-interest rows for one symbol.
 *
 * `since` bounds the window because the dataset holds years of settlement dates
 * and the API refuses to sort without an EQUAL filter on its partition key — so
 * an unbounded request silently returns the OLDEST rows, which reads as stale
 * data rather than as a paging artefact. Verified: an unbounded PNC request
 * returned 2019-01-31 through 2020-04-15.
 */
export async function fetchShortInterest(symbol, {
  since = null,
  until = null,
  limit = 60,
  dataset = 'consolidated',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const ds = DATASETS[dataset];
  if (!ds) throw new Error(`Unknown dataset "${dataset}". Use one of: ${Object.keys(DATASETS).join(', ')}.`);
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('A symbol is required.');

  const token = await accessToken({ timeoutMs });
  const body = {
    limit,
    compareFilters: [{ fieldName: ds.symbol_field, fieldValue: sym, compareType: 'EQUAL' }],
    ...(since || until
      ? { dateRangeFilters: [{ fieldName: 'settlementDate', startDate: since, endDate: until }] }
      : {}),
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${DATA_BASE}/${ds.name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    // 204 means the query was valid and matched nothing. For a listed symbol
    // against the OTC-only dataset that is the expected answer, and saying so
    // is more useful than "no short interest".
    if (res.status === 204) {
      return {
        rows: [],
        dataset: ds.name,
        empty_reason: dataset === 'otc'
          ? `${sym} returned no rows from ${ds.name}, which covers OTC securities only. If ${sym} is exchange-listed, use dataset "consolidated".`
          : `${sym} returned no rows from ${ds.name} in the requested window.`,
      };
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        tokenCache.token = null;
        throw new Error(`FINRA refused the request (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      throw new Error(`FINRA data request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    const rows = text ? JSON.parse(text) : [];
    const list = Array.isArray(rows) ? rows : [];
    return {
      rows: list,
      dataset: ds.name,
      // Hitting the limit exactly means rows were probably dropped — and they
      // are dropped from the NEWEST end, which is the dangerous direction.
      ...(list.length >= limit ? { truncated: true, limit } : {}),
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`FINRA data request timed out after ${timeoutMs}ms.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Roughly how many bi-monthly settlement rows a day-span can hold, with slack. */
const ROWS_PER_DAY = 2 / 30;

/**
 * Fetch the newest `periods` settlement rows for a symbol.
 *
 * This exists because of a trap the raw endpoint sets. The API refuses to sort
 * without an EQUAL filter on its partition key, and its `limit` truncates from
 * the OLDEST end of the window — so a limit smaller than the number of rows in
 * the window silently discards the MOST RECENT periods. Caught live: asking for
 * 12 periods with limit 24 over an eight-month window returned rows ending at
 * 2026-05-15 when 2026-07-15 was available, and the staleness check then
 * correctly reported 75-day-old data. That reads as a FINRA outage when it is a
 * paging bug, which is precisely the kind of failure a success flag hides.
 *
 * So: size the limit above what the window can possibly hold, and if the
 * response still comes back at the cap, retry with a bigger one rather than
 * returning a quietly-truncated series.
 */
export async function fetchSeries(symbol, {
  periods = 12,
  asOf,
  dataset = 'consolidated',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!asOf) throw new Error('fetchSeries needs an asOf date so the window is deterministic.');

  // Window: enough days for `periods` bi-monthly rows, plus a month of slack
  // for the publication lag and for irregular settlement dates.
  const spanDays = Math.ceil(periods / ROWS_PER_DAY) + 35;
  const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - spanDays * 86400000).toISOString().slice(0, 10);

  // Ceiling on rows the window can hold, doubled — the limit must not bind.
  let limit = Math.max(Math.ceil(spanDays * ROWS_PER_DAY) * 2, 40);

  let result = await fetchShortInterest(symbol, { since, until: asOf, limit, dataset, timeoutMs });
  let retries = 0;
  while (result.truncated && retries < 2) {
    limit *= 4;
    retries += 1;
    result = await fetchShortInterest(symbol, { since, until: asOf, limit, dataset, timeoutMs });
  }

  return {
    ...result,
    window: { since, until: asOf, limit },
    ...(result.truncated
      ? {
          truncation_warning:
            `FINRA capped the response at ${limit} rows for ${symbol}. Its limit drops the NEWEST periods first, so the `
            + 'series below may be missing recent settlement dates — do not read the resulting age as a data outage.',
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// pure analysis
// ---------------------------------------------------------------------------

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (v, dp = 2) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** Whole days between two ISO dates, positive when `to` is later. */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * How old the newest figure is, and whether that is normal.
 *
 * A 200 is not freshness — the same rule the TA client follows. Short interest
 * is bi-monthly and published on a lag, so ~1-3 weeks old is CORRECT and saying
 * "stale" there would be wrong. Past `stale_after_days` a scheduled report has
 * probably been missed.
 */
export function staleness(settlementDate, asOfIso) {
  const age = daysBetween(settlementDate, asOfIso);
  if (age === null) return { available: false, note: 'Could not parse the settlement date.' };
  const stale = age > REPORTING.stale_after_days;
  return {
    available: true,
    settlement_date: String(settlementDate).slice(0, 10),
    as_of: String(asOfIso).slice(0, 10),
    age_days: age,
    stale,
    verdict: stale
      ? `The newest settlement date is ${age} days old. Short interest is published twice a month, so past `
        + `${REPORTING.stale_after_days} days a scheduled report is missing rather than merely lagging. Say the age out loud.`
      : `${age} days old, which is normal: settlement is twice monthly and publication lags by about `
        + `${REPORTING.typical_publication_lag_days} business days. This is the resolution of the measurement, not a delay.`,
  };
}

/**
 * Split a change in days-to-cover into the part driven by the short position
 * and the part driven by average volume.
 *
 * This is the fix for the flaw in Shannon's own Figure 15.1. In log terms
 * ln(DTC) = ln(SI) - ln(ADV), so the two contributions are additive and their
 * shares of the total are well defined. `driver` names whichever moved the
 * ratio more, so a caller cannot read a liquidity change as a positioning
 * change.
 */
export function decomposeDaysToCover(prev, curr) {
  const si0 = num(prev?.short_interest); const si1 = num(curr?.short_interest);
  const adv0 = num(prev?.average_daily_volume); const adv1 = num(curr?.average_daily_volume);
  if (![si0, si1, adv0, adv1].every((v) => Number.isFinite(v) && v > 0)) {
    return { available: false, note: 'Need positive short interest and average volume in both periods.' };
  }

  const dSi = Math.log(si1 / si0);
  const dAdv = -Math.log(adv1 / adv0);
  const total = dSi + dAdv;
  const scale = Math.abs(dSi) + Math.abs(dAdv);

  const siPct = round((si1 / si0 - 1) * 100, 2);
  const advPct = round((adv1 / adv0 - 1) * 100, 2);
  const dtcPct = round((Math.exp(total) - 1) * 100, 2);

  const driver = scale === 0
    ? 'neither'
    : Math.abs(dSi) >= Math.abs(dAdv) ? 'short_interest' : 'average_volume';

  return {
    available: true,
    days_to_cover_change_pct: dtcPct,
    short_interest_change_pct: siPct,
    average_volume_change_pct: advPct,
    /** Share of the ratio's movement attributable to each side, 0..1. */
    attribution: {
      short_interest: scale === 0 ? 0 : round(Math.abs(dSi) / scale, 3),
      average_volume: scale === 0 ? 0 : round(Math.abs(dAdv) / scale, 3),
    },
    driver,
    note: driver === 'average_volume'
      ? `Days-to-cover moved ${dtcPct}% but the SHORT POSITION only moved ${siPct}% — average volume moved ${advPct}%. `
        + 'This is a change in liquidity, not in short conviction. Do not read it as shorts covering or piling in.'
      : driver === 'short_interest'
        ? `Days-to-cover moved ${dtcPct}% and the short position itself moved ${siPct}% (volume ${advPct}%). `
          + 'The ratio is tracking positioning here.'
        : 'Nothing moved.',
  };
}

/**
 * Normalise one raw FINRA row, recomputing days-to-cover past FINRA's clamp.
 */
export function normalizeRow(row) {
  const si = num(row.currentShortPositionQuantity ?? row.currentShortShareNumber);
  const prevSi = num(row.previousShortPositionQuantity ?? row.previousShortShareNumber);
  const adv = num(row.averageDailyVolumeQuantity ?? row.averageShortShareNumber);
  const reported = num(row.daysToCoverQuantity ?? row.daysToCoverNumber);
  const computed = si !== null && adv ? si / adv : null;

  const clamped = reported !== null && computed !== null
    && ((reported === DTC_SENTINELS.floor && computed < DTC_SENTINELS.floor)
      || (reported === DTC_SENTINELS.ceiling && computed > DTC_SENTINELS.ceiling));

  return {
    settlement_date: String(row.settlementDate || '').slice(0, 10),
    symbol: row.symbolCode || row.issueSymbolIdentifier || null,
    issue_name: row.issueName || null,
    market: row.marketClassCode || row.marketCategoryDescription || null,
    short_interest: si,
    previous_short_interest: prevSi,
    short_interest_change: num(row.changePreviousNumber),
    short_interest_change_pct: num(row.changePercent ?? row.percentageChangefromPreviousShort),
    average_daily_volume: adv,
    days_to_cover_reported: reported,
    days_to_cover_computed: round(computed, 3),
    ...(clamped ? { days_to_cover_clamped: true, clamp_note: DTC_SENTINELS.note } : {}),
    // Both flags change how a row should be read, so neither is dropped.
    ...(row.revisionFlag ? { revised: true } : {}),
    ...(row.stockSplitFlag ? { split_adjusted: true } : {}),
  };
}

/**
 * Average price over a settlement period — an estimate of the price at which
 * the shorts established their position.
 *
 * Shannon adds a VWAP column to his short-interest table for exactly this:
 * "it offers an idea of the average price at which short sellers may be
 * involved." It is the only way to tell squeeze fuel from a comfortable short,
 * because his own mechanism turns on the shorts' P&L — shorts sitting on gains
 * "are less likely to panic and buy at the first signs of strength."
 *
 * `bars` are normalised OHLCV with a `time` in ms. Returns null rather than a
 * guess when the window holds no bars.
 */
export function periodVwap(bars, startIso, endIso) {
  const start = Date.parse(`${String(startIso).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(endIso).slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Array.isArray(bars)) return null;

  let pv = 0; let vol = 0; let n = 0; let sum = 0;
  for (const b of bars) {
    const t = Number(b.time);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    const typical = [b.high, b.low, b.close].every((v) => Number.isFinite(Number(v)))
      ? (Number(b.high) + Number(b.low) + Number(b.close)) / 3
      : Number(b.close);
    if (!Number.isFinite(typical)) continue;
    n += 1; sum += typical;
    const v = Number(b.volume);
    if (Number.isFinite(v) && v > 0) { pv += typical * v; vol += v; }
  }
  if (!n) return null;
  // Fall back to the unweighted mean when volume is missing, and say which.
  return vol > 0
    ? { vwap: round(pv / vol, 4), bars: n, weighted: true }
    : { vwap: round(sum / n, 4), bars: n, weighted: false, note: 'No usable volume in the window — unweighted mean of typical price.' };
}

/**
 * Are the shorts in profit? Positive `shorts_pnl_pct` means the position is
 * profitable for them, which per Shannon means LESS squeeze pressure.
 */
export function shortsPosition(entryVwap, lastPrice) {
  const e = num(entryVwap); const p = num(lastPrice);
  if (!Number.isFinite(e) || !Number.isFinite(p) || e <= 0) {
    return { available: false, note: 'Need a period VWAP and a current price.' };
  }
  const pnl = round(((e - p) / e) * 100, 2);
  const underwater = pnl < 0;
  return {
    available: true,
    estimated_short_entry: e,
    last_price: p,
    shorts_pnl_pct: pnl,
    shorts_underwater: underwater,
    reading: underwater
      ? `Price is ${Math.abs(pnl)}% ABOVE the period VWAP, so shorts established in this period are underwater. `
        + 'This is the condition Shannon attaches squeeze pressure to — a large short position only becomes fuel when the shorts are losing.'
      : `Price is ${pnl}% below the period VWAP, so shorts established in this period are in profit. Shannon: shorts with `
        + 'accumulated gains "are less likely to panic and buy at the first signs of strength" — a large short position here is NOT squeeze fuel.',
    caveat: 'A period VWAP is a crude proxy for the shorts\' actual cost basis. It assumes the position was built evenly '
      + 'across the period, which nothing verifies.',
  };
}

/**
 * Build the full picture from raw rows: Shannon's Figure 15.1 table, newest
 * first, with the ratio decomposed and the freshness stated.
 *
 * `asOf` is required rather than defaulted to now, so the same rows always
 * produce the same result and the caller owns the clock.
 *
 * `periods` truncates AFTER sorting. Doing it before — slicing the raw rows,
 * which arrive oldest-first — throws away the newest settlement dates, the same
 * mistake FINRA's own `limit` makes.
 */
export function buildSeries(rows, { asOf, bars = null, lastPrice = null, periods = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return { available: false, note: 'No short-interest rows to summarise.' };
  }
  if (!asOf) throw new Error('buildSeries needs an asOf date to report staleness against.');

  const sorted = rows
    .map(normalizeRow)
    .filter((r) => r.settlement_date)
    .sort((a, b) => (a.settlement_date < b.settlement_date ? 1 : -1));
  const series = periods ? sorted.slice(0, Math.max(periods, 2)) : sorted;

  const latest = series[0];
  const prior = series[1] || null;

  // Attach the period VWAP and the shorts' implied P&L, when bars are supplied.
  if (bars) {
    for (let i = 0; i < series.length; i += 1) {
      const next = series[i + 1];
      if (!next) continue; // no start boundary for the oldest period
      const v = periodVwap(bars, next.settlement_date, series[i].settlement_date);
      if (v) series[i].period_vwap = v.vwap;
    }
  }

  const trend = (() => {
    const withSi = series.filter((r) => Number.isFinite(r.short_interest)).slice(0, 4);
    if (withSi.length < 2) return null;
    const first = withSi[withSi.length - 1].short_interest;
    const last = withSi[0].short_interest;
    return {
      periods: withSi.length,
      from: withSi[withSi.length - 1].settlement_date,
      to: withSi[0].settlement_date,
      change_pct: round((last / first - 1) * 100, 2),
      direction: last > first ? 'building' : last < first ? 'covering' : 'flat',
    };
  })();

  return {
    available: true,
    symbol: latest.symbol,
    issue_name: latest.issue_name,
    market: latest.market,
    periods: series.length,
    freshness: staleness(latest.settlement_date, asOf),
    latest: {
      settlement_date: latest.settlement_date,
      short_interest: latest.short_interest,
      average_daily_volume: latest.average_daily_volume,
      days_to_cover: latest.days_to_cover_computed,
      days_to_cover_reported: latest.days_to_cover_reported,
      ...(latest.days_to_cover_clamped ? { days_to_cover_clamped: true } : {}),
      ...(latest.revised ? { revised: true } : {}),
      short_pct_of_float: null,
      short_pct_of_float_note: 'FINRA publishes no share count, so short interest as a percentage of float is NOT available here. '
        + 'Never infer it — that needs a float figure from another source.',
    },
    ...(prior ? { vs_prior_period: decomposeDaysToCover(prior, latest) } : {}),
    days_to_cover_driver_study: DAYS_TO_COVER_DRIVER_STUDY,
    ...(trend ? { recent_trend: trend } : {}),
    ...(lastPrice !== null && latest.period_vwap
      ? { shorts_position: shortsPosition(latest.period_vwap, lastPrice) }
      : {}),
    series,
    how_to_use: HOW_TO_USE,
  };
}

export const HOW_TO_USE = Object.freeze({
  role: 'CONTEXT, not a signal. Attach it to a setup found some other way — the same way ta_trading_context is used.',
  shannon: 'A large outstanding short position or short interest ratio by itself is not a reason for buying a stock in '
    + 'anticipation of a short squeeze. The informed trader will find an edge when there is a preponderance of indicators '
    + 'leading to a price advance. Nonetheless, it is an excellent gauge of potential demand.',
  why_it_is_demand: 'Every share sold short must eventually be bought back, so short interest is future demand with a '
    + 'known direction and an unknown date.',
  the_asymmetry: 'Squeeze pressure needs shorts who are LOSING. A large short position in a stock still declining is '
    + 'not fuel — those shorts hold gains and can sit. Check shorts_position before calling anything a squeeze setup.',
  do_not: [
    'Do not quote days-to-cover alone. MEASURED: 93% of days-to-cover moves of 20% or more (426 of 458, over 40 symbols '
      + 'and 1000 period changes) were driven by AVERAGE VOLUME, not by the short position. Read vs_prior_period.driver first.',
    'Do not use the reported days-to-cover when it is clamped — FINRA floors it at 1.00 and caps it at 999.99.',
    'Do not short on valuation. Shannon: "do not sell short when you think a stock is up too much, the P/E is too high '
      + 'or any other subjective reason."',
    'Do not report a short percentage of float from this data. It is not in the feed.',
  ],
  source: 'FINRA Rule 4560 consolidated short interest. Framing from Shannon, Technical Analysis Using Multiple '
    + 'Timeframes (2008), ch. 15 "The Short Squeeze".',
});
