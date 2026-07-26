/**
 * Sync TradingView's watchlist from Tactical Alpha's watchlist files.
 *
 * TA is the master. The sync is deliberately ADDITIVE ONLY: symbols TA has and
 * TradingView lacks get added to the matching section; nothing is ever removed.
 * Anything added by hand in TradingView therefore survives.
 *
 * TradingView stores a watchlist as a flat ordered array where section headers
 * are entries prefixed "###":
 *
 *   ["###PORTFOLIO - STOCKS & ETFS", "NASDAQ:AMD", ..., "###WATCHLIST - AI", ...]
 *
 * Section names can contain invisible characters (some here start with U+2064),
 * so they are matched and rewritten byte-for-byte rather than normalised.
 *
 *   read:  GET  /api/v1/symbols_list/active/
 *   write: POST /api/v1/symbols_list/custom/{id}/replace/   body = the full array
 */
import { evaluateAsync } from '../connection.js';
import * as ta from './ta_api.js';

const TV = 'https://www.tradingview.com';
const SECTION_PREFIX = '###';

/**
 * TA watchlist file -> TradingView section.
 *
 * Matched on the section name with "WATCHLIST - "/"PORTFOLIO - " stripped and
 * case-folded, so the invisible characters in the real names do not have to be
 * reproduced here. Files with no mapping are reported, never guessed at: adding
 * a screen's output to the wrong section would be silent and hard to undo.
 *
 * PORTFOLIO sections are intentionally absent — those reflect holdings, and
 * belong to TA's portfolio rather than a watchlist file.
 */
export const DEFAULT_MAPPING = {
  'watchlist.csv': 'GENERAL',
  'sector_etfs_extended.csv': 'SECTOR ETFS',
  'watchlistAI.csv': 'AI',
  'watchlistAIadop.csv': 'AI ADOPTERS',
  'watchlistAIPS.csv': 'AI SCREEN',
  'watchlistST2026.csv': 'SWING 2026',
  'watchlistMix.csv': 'MIX',
  'watchlistMOT.csv': 'MOT',
  'watchlistMEMPS.csv': 'MEMPS',
  'watchlistNUPS.csv': 'NUPS',
  'watchlistQPS.csv': 'QPS',
  'watchlistRPS.csv': 'RPS',
  'watchlistSPPS.csv': 'SPPS',
};

/** "⁤WATCHLIST - AI SCREEN" -> "AI SCREEN" */
function sectionKey(name) {
  return String(name)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/^\s*(WATCHLIST|PORTFOLIO)\s*-\s*/i, '')
    .trim()
    .toUpperCase();
}

/** Bare ticker from a TradingView symbol: "NASDAQ:AMD" -> "AMD" */
export function bare(symbol) {
  return String(symbol || '').toUpperCase().replace(/^.*:/, '').trim();
}

/**
 * Suffix conventions TA uses for non-US listings, mapped to TradingView
 * exchanges. TA writes "RHM.DE"; TradingView wants "XETR:RHM".
 */
const SUFFIX_EXCHANGE = {
  DE: 'XETR', F: 'FWB', L: 'LSE', PA: 'EURONEXT', AS: 'EURONEXT', BR: 'EURONEXT',
  MI: 'MIL', MC: 'BME', SW: 'SIX', ST: 'OMXSTO', HE: 'OMXHEX', CO: 'OMXCOP',
  OL: 'EURONEXT', TO: 'TSX', V: 'TSXV', HK: 'HKEX', T: 'TSE', AX: 'ASX',
  SI: 'SGX', NS: 'NSE', BO: 'BSE', SS: 'SSE', SZ: 'SZSE', KS: 'KRX', TW: 'TWSE',
};

/**
 * Crypto needs a quote currency and a venue: TA carries "BTC", TradingView
 * needs "COINBASE:BTCUSD". Matches the convention already in the watchlist.
 */
const CRYPTO_EXCHANGE = 'COINBASE';
const CRYPTO_QUOTE = 'USD';

/**
 * Explicit overrides, applied before every rule below. Extend this when a
 * ticker resolves to the wrong instrument or has no automatic equivalent —
 * an explicit entry is always safer than a heuristic.
 */
export const SYMBOL_ALIASES = {
  // Indices and instruments whose TA name differs from TradingView's
  SPX: 'SP:SPX',
  VIX: 'CBOE:VIX',
  VVIX: 'CBOE:VVIX',
  US10Y: 'TVC:US10Y',
  DXY: 'TVC:DXY',
  GOLD: 'TVC:GOLD',
};

/**
 * Turn a TA ticker into a TradingView symbol without a network round trip,
 * where the convention makes it unambiguous. Returns null when a real lookup
 * is needed — guessing an exchange would silently point at a different listing.
 */
export function equivalentFor(ticker, { crypto = false, aliases = {} } = {}) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!t) return null;

  const override = { ...SYMBOL_ALIASES, ...aliases }[t];
  if (override) return override;

  if (t.includes(':')) return t; // already fully qualified

  const dot = t.lastIndexOf('.');
  if (dot > 0) {
    const suffix = t.slice(dot + 1);
    const exchange = SUFFIX_EXCHANGE[suffix];
    if (exchange) return `${exchange}:${t.slice(0, dot)}`;
  }

  if (crypto) {
    // Already carries a quote currency (BTCUSD, ETHUSDT) — leave it alone.
    if (/USD[T]?$/.test(t)) return `${CRYPTO_EXCHANGE}:${t}`;
    return `${CRYPTO_EXCHANGE}:${t}${CRYPTO_QUOTE}`;
  }

  return null;
}

/** Read the active TradingView watchlist, split into ordered sections. */
export async function readTvWatchlist() {
  const d = await evaluateAsync(`
    fetch("${TV}/api/v1/symbols_list/active/", { credentials: "include" })
      .then(function(r) { return r.json(); })
      .catch(function(e) { return { err: e.message }; })
  `);
  if (!d || d.err) throw new Error(`Could not read the TradingView watchlist: ${d?.err || 'no response'}`);
  if (!Array.isArray(d.symbols)) throw new Error('TradingView returned a watchlist with no symbols array.');

  const sections = [];
  let current = null;
  for (const entry of d.symbols) {
    if (String(entry).startsWith(SECTION_PREFIX)) {
      current = { header: entry, name: String(entry).slice(SECTION_PREFIX.length), key: sectionKey(String(entry).slice(SECTION_PREFIX.length)), symbols: [] };
      sections.push(current);
    } else if (current) {
      current.symbols.push(entry);
    } else {
      // Symbols before any header — keep them in an unnamed leading group so
      // rebuilding the array cannot silently drop them.
      current = { header: null, name: '(no section)', key: '', symbols: [entry] };
      sections.push(current);
    }
  }

  return { id: d.id, name: d.name, raw: d.symbols, sections, total: d.symbols.length };
}

/** Read every TA watchlist file, returning bare tickers per file. */
export async function readTaWatchlists() {
  const idx = await ta.get('/api/watchlists');
  const files = idx.data?.watchlists || [];
  const out = {};

  for (const f of files) {
    try {
      const r = await ta.get(`/api/watchlists/${f.name}`, { raw: true, timeoutMs: 30000 });
      const lines = (r.text || '').trim().split('\n').filter(Boolean);
      if (lines.length < 2) { out[f.name] = { tickers: [], modified: f.modified }; continue; }
      // First column is Ticker in every TA watchlist file.
      const tickers = lines.slice(1)
        .map((l) => l.split(',')[0].trim().toUpperCase())
        .filter((t) => t && /^[A-Z0-9.\-]{1,12}$/.test(t));
      out[f.name] = { tickers: [...new Set(tickers)], modified: f.modified };
    } catch (err) {
      out[f.name] = { tickers: [], error: err.message };
    }
  }
  return out;
}

/**
 * Resolve a bare ticker to a TradingView symbol ("AMD" -> "NASDAQ:AMD").
 *
 * TradingView stores fully-qualified symbols; writing a bare ticker produces an
 * entry that does not resolve. Symbols already somewhere in the watchlist are
 * reused, which avoids a search for the common case.
 */
async function resolveSymbols(tickers, known, { crypto = false, aliases = {} } = {}) {
  const resolved = {};
  const unresolved = [];

  const pending = [];
  for (const t of tickers) {
    // Already in the watchlist somewhere — reuse the exact symbol it uses.
    if (known.has(t)) { resolved[t] = known.get(t); continue; }
    // A known convention (exchange suffix, crypto pair, explicit alias).
    const eq = equivalentFor(t, { crypto, aliases });
    if (eq) { resolved[t] = eq; continue; }
    pending.push(t);
  }

  for (const t of pending) {
    const hit = await evaluateAsync(`
      fetch("${TV}/api/v1/symbols_list/search/?text=" + encodeURIComponent(${JSON.stringify(t)}), { credentials: "include" })
        .then(function(r) { return r.ok ? r.json() : null; })
        .catch(function() { return null; })
    `).catch(() => null);

    let symbol = null;
    const rows = Array.isArray(hit) ? hit : (hit?.symbols || hit?.data || []);
    for (const row of rows || []) {
      const s = row?.symbol || row?.full_name || row?.ticker;
      const ex = row?.exchange || row?.exchange_name;
      if (!s) continue;
      const full = String(s).includes(':') ? String(s) : (ex ? `${ex}:${s}` : null);
      if (full && bare(full) === t) { symbol = full; break; }
    }
    if (symbol) resolved[t] = symbol; else unresolved.push(t);
  }

  return { resolved, unresolved };
}

/**
 * Work out what would change. Pure planning — writes nothing.
 * Returns per-section additions plus everything that could not be placed.
 */
export async function planSync({ mapping } = {}) {
  const map = { ...DEFAULT_MAPPING, ...(mapping || {}) };
  const tv = await readTvWatchlist();
  const taLists = await readTaWatchlists();

  // Every symbol already anywhere in the watchlist, so additions are judged
  // against the whole list and duplicates cannot be introduced across sections.
  const known = new Map();
  for (const s of tv.sections) for (const sym of s.symbols) known.set(bare(sym), sym);

  const byKey = new Map(tv.sections.map((s) => [s.key, s]));
  const plan = [];
  const unmappedFiles = [];
  const missingSections = [];
  let totalAdds = 0;

  for (const [file, data] of Object.entries(taLists)) {
    const target = map[file];
    if (!target) { unmappedFiles.push({ file, tickers: data.tickers.length }); continue; }

    const section = byKey.get(sectionKey(target));
    if (!section) { missingSections.push({ file, wanted: target }); continue; }

    const present = new Set(section.symbols.map(bare));
    const missing = data.tickers.filter((t) => !present.has(t) && !known.has(t));
    const elsewhere = data.tickers.filter((t) => !present.has(t) && known.has(t));

    if (missing.length || elsewhere.length) {
      plan.push({
        file,
        section: section.name,
        section_key: section.key,
        current_count: section.symbols.length,
        to_add: missing,
        already_elsewhere: elsewhere,
      });
      totalAdds += missing.length;
    }
  }

  return {
    success: true,
    watchlist: { id: tv.id, name: tv.name, total_entries: tv.total, sections: tv.sections.length },
    ta_files: Object.keys(taLists).length,
    additions_planned: totalAdds,
    plan,
    ...(unmappedFiles.length ? { unmapped_ta_files: unmappedFiles } : {}),
    ...(missingSections.length ? { missing_tv_sections: missingSections } : {}),
    note: 'Additive only — nothing is removed. already_elsewhere lists symbols present in a different section, which are left where they are.',
  };
}

/**
 * Apply the plan.
 *
 * Rebuilds the full array section by section, preserving order, header text and
 * every existing symbol, then writes it back in one call. Verifies afterwards
 * that the count grew by exactly the number added and that no prior symbol went
 * missing — a replace endpoint makes a silent truncation possible, and this is
 * the user's 300-symbol watchlist.
 */
export async function applySync({ mapping, dry_run = false } = {}) {
  const planned = await planSync({ mapping });
  if (dry_run || !planned.additions_planned) {
    return { ...planned, applied: false, ...(planned.additions_planned ? { dry_run: true } : { note: 'Nothing to add — TradingView already has every mapped TA symbol.' }) };
  }

  const tv = await readTvWatchlist();
  const known = new Map();
  for (const s of tv.sections) for (const sym of s.symbols) known.set(bare(sym), sym);

  // Crypto sections need a venue and quote currency appended; equity sections
  // must not have that applied, so resolution runs per section.
  const resolved = {};
  const unresolved = [];
  for (const p of planned.plan) {
    if (!p.to_add.length) continue;
    const isCrypto = /CRYPTO/i.test(p.section_key);
    const r = await resolveSymbols(p.to_add, known, { crypto: isCrypto, aliases: mapping?.aliases });
    Object.assign(resolved, r.resolved);
    unresolved.push(...r.unresolved);
  }

  const bySection = new Map(planned.plan.map((p) => [p.section_key, p]));
  const before = new Set(tv.raw.filter((s) => !String(s).startsWith(SECTION_PREFIX)));

  // Deduplicate on the RESOLVED symbol, not the source ticker. A TA ticker and
  // its TradingView equivalent often differ ("RHM.DE" -> "XETR:RHM", "BTC" ->
  // "COINBASE:BTCUSD"), so a ticker can look absent while its equivalent is
  // already in the list. TradingView rejects the whole write with 422 if any
  // symbol repeats, which would fail the entire sync over one duplicate.
  const alreadyPresent = new Set(before);
  const seen = new Set();
  const skippedDuplicates = [];

  const next = [];
  const added = [];
  for (const section of tv.sections) {
    if (section.header) next.push(section.header);
    next.push(...section.symbols);
    const p = bySection.get(section.key);
    if (!p) continue;
    for (const t of p.to_add) {
      const sym = resolved[t];
      if (!sym) continue;
      if (alreadyPresent.has(sym) || seen.has(sym)) {
        skippedDuplicates.push({ ticker: t, resolves_to: sym });
        continue;
      }
      seen.add(sym);
      next.push(sym);
      added.push({ symbol: sym, section: section.name });
    }
  }

  if (!added.length) {
    return {
      success: true,
      applied: false,
      entries: tv.total,
      ...(skippedDuplicates.length ? { skipped_duplicates: skippedDuplicates } : {}),
      note: 'Nothing to write — every planned addition already exists under its TradingView equivalent.',
    };
  }

  // Guard before writing: never shrink, never lose an existing entry.
  const missingNow = [...before].filter((s) => !next.includes(s));
  if (missingNow.length) {
    throw new Error(`Refusing to write: rebuilding the watchlist would drop ${missingNow.length} existing symbols (${missingNow.slice(0, 5).join(', ')}). No changes made.`);
  }
  if (next.length < tv.total) {
    throw new Error(`Refusing to write: rebuilt watchlist is smaller (${next.length} vs ${tv.total}). No changes made.`);
  }

  const res = await evaluateAsync(`
    fetch("${TV}/api/v1/symbols_list/custom/${tv.id}/replace/", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(next))}
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, ok: r.ok, body: t.slice(0, 200) }; }); })
      .catch(function(e) { return { err: e.message }; })
  `);

  if (res?.err) throw new Error(`Watchlist write failed: ${res.err}`);
  if (!res?.ok) throw new Error(`Watchlist write rejected (HTTP ${res?.status}): ${res?.body}`);

  const after = await readTvWatchlist();
  const grew = after.total - tv.total;
  if (grew !== added.length) {
    throw new Error(`Wrote the watchlist but the entry count moved by ${grew}, expected ${added.length}. Check it — a backup of the previous list is in backups/.`);
  }

  return {
    success: true,
    applied: true,
    verified: true,
    entries_before: tv.total,
    entries_after: after.total,
    added: added.length,
    added_symbols: added,
    ...(skippedDuplicates.length ? { skipped_duplicates: skippedDuplicates, skipped_note: 'Already present under their TradingView equivalent.' } : {}),
    ...(unresolved.length ? { unresolved, unresolved_note: 'These tickers had no TradingView match and were skipped rather than written as bare tickers, which would not resolve.' } : {}),
    ...(planned.unmapped_ta_files ? { unmapped_ta_files: planned.unmapped_ta_files } : {}),
    note: 'Additive only — no symbols were removed and section order is unchanged.',
  };
}
