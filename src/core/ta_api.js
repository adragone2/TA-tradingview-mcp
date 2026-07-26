/**
 * Client for the Tactical Alpha API.
 *
 * TA is the master system: it runs on the VPS, holds the databases, watchlists,
 * portfolio and macro state, and is oriented around *investing*. This MCP is
 * oriented around *trading* — charts, levels, entries. The two are
 * complementary, and this module is the seam.
 *
 * What TA contributes to a trading decision that a chart cannot:
 *   - what you already own, and how much
 *   - when a name reports
 *   - what regime the market is in
 *
 * Credentials are never hardcoded. TA_API_KEY comes from the environment or a
 * git-ignored .env, so a key is not embedded in source or in tool arguments.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

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

/**
 * Load config from this project's .env, and optionally from an env file that
 * already holds the key.
 *
 * TA_ENV_FILE exists so the key can stay in one place rather than being copied
 * here — a secret duplicated into a second file is a second thing to rotate
 * and a second thing to leak.
 */
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  readEnvFile(join(PROJECT_ROOT, '.env'));
  if (process.env.TA_ENV_FILE) readEnvFile(process.env.TA_ENV_FILE);
}

const DEFAULT_TIMEOUT_MS = 20000;

function config() {
  loadEnv();
  // Default to the domain rather than the raw IP so the request goes through
  // nginx and is TLS-terminated.
  const baseUrl = (process.env.TA_API_URL || 'https://tacticalalpha.io').replace(/\/+$/, '');
  const apiKey = process.env.TA_API_KEY || null;
  return { baseUrl, apiKey };
}

/** Config visibility without exposing the key. */
export function apiStatus() {
  const { baseUrl, apiKey } = config();
  return {
    success: true,
    base_url: baseUrl,
    api_key_configured: !!apiKey,
    ...(process.env.TA_ENV_FILE ? { key_sourced_from: process.env.TA_ENV_FILE } : {}),
    ...(apiKey ? {} : {
      hint: 'TA_API_KEY is not set. Either add it to .env at the project root (git-ignored), or set TA_ENV_FILE to an existing env file that already defines it so the key lives in one place. Never pass it as a tool argument.',
    }),
  };
}

/**
 * GET a TA endpoint.
 * `requireAuth: false` is used for /health, which is reachable unauthenticated
 * and is therefore the right probe for "is TA up" versus "is my key wrong".
 */
export async function get(path, { params, timeoutMs = DEFAULT_TIMEOUT_MS, requireAuth = true, raw = false } = {}) {
  const { baseUrl, apiKey } = config();

  if (requireAuth && !apiKey) {
    throw new Error(
      'TA_API_KEY is not set. Add it to .env at the project root (git-ignored), or export TA_API_KEY. ' +
      'Do not paste the key into a chat or into tool arguments.',
    );
  }

  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      },
      signal: ac.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Some endpoints return CSV (the dataset sync routes serve whole files).
      // Callers that need the file pass raw:true; without it the preview is
      // capped so a 16 MB dataset cannot be dumped into a tool response by
      // accident.
      body = raw ? null : { raw: text.slice(0, 2000), truncated: text.length > 2000, total_length: text.length };
    }

    if (!res.ok) {
      // Distinguish the failure modes that need different fixes.
      // 403 is not always an auth problem: the dataset sync route returns it
      // for datasets that exist but are not SHARED. Blaming the key there sends
      // you to check a credential that is working fine.
      const detail = body?.detail || body?.message || '';
      if (res.status === 403) {
        throw new Error(
          `TA API refused ${path} (HTTP 403)${detail ? `: ${detail}` : ''}. ` +
          (/not SHARED/i.test(detail)
            ? 'This dataset is user-scoped, and /api/v1/sync only serves SHARED datasets — the key is not the problem.'
            : 'Check TA_API_KEY and that it is still valid for your user.'),
        );
      }
      if (res.status === 401) {
        throw new Error(`TA API rejected the key (HTTP 401) for ${path}${detail ? `: ${detail}` : ''}. Check TA_API_KEY.`);
      }
      if (res.status === 404) {
        throw new Error(`No such TA endpoint: ${path} (HTTP 404). Use ta_list_endpoints to see what this deployment exposes.`);
      }
      if (res.status === 429) {
        throw new Error(`TA API rate limit hit (HTTP 429) for ${path}. Back off before retrying.`);
      }
      throw new Error(`TA API error HTTP ${res.status} for ${path}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    // TA stamps freshness from the source file's mtime, not request time, so a
    // 200 does not mean the data is current. Surfaced on every response.
    const generatedAt = res.headers.get('X-Data-Generated-At');
    const ageHours = res.headers.get('X-Data-Age-Hours');
    const freshness = (generatedAt || ageHours)
      ? {
          generated_at: generatedAt || null,
          age_hours: ageHours !== null && ageHours !== '' ? Number(ageHours) : null,
        }
      : null;

    return {
      success: true,
      path,
      elapsed_ms: Date.now() - started,
      data: body,
      ...(freshness ? { freshness } : {}),
      ...(raw ? { text } : {}),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`TA API timed out after ${timeoutMs}ms for ${path}. The VPS may be busy or unreachable.`);
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message)) {
      throw new Error(
        `Could not reach the TA API at ${baseUrl} (${err.message}). Check the VPS is up and TA_API_URL is correct.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Unauthenticated liveness probe, so "TA is down" is distinguishable from "my key is wrong". */
export async function health() {
  try {
    const res = await get('/health', { requireAuth: false, timeoutMs: 10000 });
    const { apiKey } = config();
    return { success: true, reachable: true, api_key_configured: !!apiKey, ...res };
  } catch (err) {
    const { baseUrl, apiKey } = config();
    return { success: false, reachable: false, base_url: baseUrl, api_key_configured: !!apiKey, error: err.message };
  }
}

// --- Named endpoints, chosen for what they add to a trading decision ---

export const portfolio = ({ live } = {}) => get(live ? '/api/portfolio/live' : '/api/portfolio');
export const portfolioSummary = () => get('/api/portfolio/summary');
export const earnings = () => get('/api/earnings');
export const alerts = () => get('/api/alerts');
export const regime = () => get('/api/regime');
export const volRegime = () => get('/api/vol-regime');
export const vix = () => get('/api/vix');
export const macro = () => get('/api/macro');
export const sectors = () => get('/api/sectors');
export const breadth = () => get('/api/breadth');
export const digest = () => get('/api/digest');
export const investingBrief = () => get('/api/v1/morning-brief');

/**
 * Position and catalyst context for specific tickers.
 *
 * This is the call worth making before acting on a chart setup: it answers
 * "do I already own this, and does it report soon" in one hop. Both are things
 * the chart cannot tell you and both change whether a setup is worth taking.
 */
export async function tradingContext({ symbols } = {}) {
  const wanted = new Set((symbols || []).map((s) => String(s).toUpperCase().replace(/^.*:/, '').trim()));

  const settled = await Promise.allSettled([
    portfolio({ live: false }),
    earnings(),
    regime(),
  ]);
  const [pos, earn, reg] = settled;

  const out = {
    success: true,
    symbols: [...wanted],
    sources: {
      portfolio: pos.status === 'fulfilled' ? 'ok' : `failed: ${pos.reason?.message}`,
      earnings: earn.status === 'fulfilled' ? 'ok' : `failed: ${earn.reason?.message}`,
      regime: reg.status === 'fulfilled' ? 'ok' : `failed: ${reg.reason?.message}`,
    },
  };

  if (reg.status === 'fulfilled') out.regime = reg.value.data;

  // Shapes differ across deployments, so match loosely on any ticker-ish field
  // rather than assuming a schema that may not hold.
  const pick = (rows, key) => {
    if (!Array.isArray(rows)) return null;
    return rows.filter((r) => {
      const t = r?.ticker || r?.symbol || r?.Ticker || r?.Symbol;
      return t && wanted.has(String(t).toUpperCase());
    }).map((r) => ({ ...r, _matched_on: key }));
  };

  // Response shapes vary by endpoint and deployment, so look through the keys
  // each one actually uses rather than assuming a single schema.
  const listFrom = (d, keys) => {
    if (Array.isArray(d)) return d;
    for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
    return null;
  };

  if (pos.status === 'fulfilled') {
    const d = pos.value.data;
    const rows = listFrom(d, ['positions', 'holdings', 'data', 'equities', 'rows']);
    const held = pick(rows, 'portfolio');
    out.held = held && held.length ? held : [];
    out.holdings_note = held === null
      ? 'Could not read a position list from the portfolio response — inspect it with ta_get.'
      : `${out.held.length} of ${wanted.size} requested symbols are already held.`;
  }

  if (earn.status === 'fulfilled') {
    const d = earn.value.data;
    // The TA earnings calendar returns { upcoming: [...] }.
    const rows = listFrom(d, ['upcoming', 'earnings', 'events', 'calendar', 'data']);
    const hits = pick(rows, 'earnings');
    out.earnings = hits && hits.length ? hits : [];
    out.earnings_note = hits === null
      ? 'Could not read an events list from the earnings response — inspect it with ta_get.'
      : `${out.earnings.length} of the requested symbols have an entry on the TA earnings calendar.`;
  }

  out.instruction = [
    'Use this as risk context, not as a signal.',
    'A symbol already held is a position-sizing and concentration question, not a fresh entry.',
    'A symbol reporting inside the intended holding window carries event risk the chart cannot show.',
    'If a source failed, say so rather than implying it was checked and came back clean.',
  ].join(' ');

  return out;
}
