/**
 * Set a list's contents to exactly `entries`, in that order.
 *
 * THREE ENDPOINTS, AND `/replace/` IS NOT THE ONE.
 *
 * Measured against the live API:
 *
 *   POST .../append/    200  adds symbols, returns the new list
 *   POST .../remove/    200  removes symbols, returns what is left
 *   POST .../replace/   422  "You can't add new symbols during safe replace
 *                            (reorder)"  code: add_new_symbols
 *                       422  "You can't remove symbols during safe replace"
 *                            code: remove_symbols
 *
 * `/replace/` is a REORDER. It rejects any write whose symbol SET differs from
 * the current one, in either direction. So a content change is
 * remove-then-append, with `/replace/` afterwards only to impose order once the
 * set matches.
 *
 * Remove runs FIRST: appending first would briefly hold both sets, and a
 * failure between the calls would leave a superset — harder to notice than a
 * subset, and harder to undo.
 *
 * Section headers ("###KEEP") are ordinary entries in this array and pass
 * through all three calls unchanged.
 */
export async function setListContents(listId, entries, { current = null } = {}) {
  const desired = [...new Set((entries || []).filter(Boolean))];
  const before = current ?? await listContentsById(listId);

  const call = async (path, symbols) => {
    if (!symbols.length) return { ok: true, skipped: true };
    const r = await pageFetch(`
      fetch("${TV}/api/v1/symbols_list/custom/${listId}/${path}/", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(symbols))}
      })
        .then(function(r){ return r.text().then(function(t){ return { status:r.status, ok:r.ok, body:t.slice(0,200) }; }); })
        .catch(function(e){ return { err: String(e) }; })
    `);
    if (!r?.ok) throw new Error(`${path} rejected (HTTP ${r?.status}): ${r?.body}`);
    return r;
  };

  const removed = before.filter((s) => !desired.includes(s));
  const added = desired.filter((s) => !before.includes(s));
  await call('remove', removed);
  await call('append', added);
  await call('replace', desired);
  return { removed: removed.length, added: added.length, total: desired.length };
}

/** A list's entries by id, without a name lookup. */
export async function listContentsById(listId) {
  const res = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${listId}; })[0];
                         return l ? (l.symbols || []) : { err: "no list with id ${listId}" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (!Array.isArray(res)) throw new Error(`Could not read list ${listId}.`);
  return res;
}

/**
 * Rewrite ONE named TradingView watchlist from scratch.
 *
 * ── Why this is not applySync ──
 *
 * `watchlist_sync.js` already writes to TradingView, and its safety rule is
 * "never shrink":
 *
 *     Refusing to write: rebuilding the watchlist would drop N existing symbols
 *     Refusing to write: rebuilt watchlist is smaller
 *
 * That is exactly right for the TA sync, whose job is never to lose a symbol
 * from a 314-entry list the user curates by hand. It is exactly wrong here,
 * where the list is regenerated every morning and shrinking is the point.
 *
 * So the guard is INVERTED rather than removed. Instead of *never shrink*, it
 * is **never write to a list you do not own**:
 *
 *   - the target is resolved by EXACT name match, never by "active"
 *   - the id is re-confirmed against that name immediately before the write
 *   - a run that cannot find the list FAILS rather than falling back
 *
 * That last point is the one that matters. TradingView's "active" list is
 * whatever the user happened to click last — on this account that is the
 * 314-entry TA list — so a fallback to active would silently replace a curated
 * watchlist with twenty screen hits.
 *
 * Everything else is reused from the sync path: same endpoints, same session,
 * same post-write verification.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../connection.js';

const TV = 'https://www.tradingview.com';

/**
 * TradingView stores a watchlist as ONE flat ordered array in which a section
 * header is an entry prefixed with `###`. Everything after a header belongs to
 * that section until the next one.
 *
 *   ["NASDAQ:VLY", "NYSE:CVS", "###KEEP", "NASDAQ:NVDA"]
 *    \_____ default section _____/         \__ KEEP __/
 */
const SECTION_PREFIX = '###';

/**
 * TradingView's own marker, U+2064 INVISIBLE PLUS, sits between the `###` and the
 * name on every header its UI creates. Measured on the live list:
 *
 *   "###⁤KEEP - POTENTIAL" => 0023 0023 0023 2064 004b 0045 0045 0050 ...
 *
 * It renders as nothing, so a header looks identical to one we wrote — and it is
 * not identical to any code comparing names. `"⁤KEEP - POTENTIAL"` does not
 * start with `"KEEP"`, so the preservation rule silently failed to match and the
 * KEEP sections would have been rewritten out of existence; the managed names
 * missed too, which would have written a second `###INTRADAY` beside the real one.
 *
 * So names are NORMALISED for every comparison, while the original header is kept
 * verbatim for any section carried through untouched, and the marker is reused on
 * headers we create so the panel stays consistent.
 */
const SECTION_MARKER = '⁤';
/** Zero-width and default-ignorable characters that can hide inside a name. */
const INVISIBLE = /[­​-‏⁠-⁤﻿]/g;

/** The comparable form of a section name. PURE. */
export const normaliseSectionName = (raw) => String(raw ?? '').replace(INVISIBLE, '').trim();

/** The header to write for a section we are creating. PURE. */
export const sectionHeader = (name) => `${SECTION_PREFIX}${SECTION_MARKER}${normaliseSectionName(name)}`;

/**
 * Split the flat array into a default section plus named ones. PURE.
 *
 * `name` is normalised and is what all matching uses; `raw_name` and `header` are
 * exactly what TradingView holds, so a preserved section round-trips byte for byte.
 */
export function parseSections(entries) {
  const out = { default: [], sections: [] };
  let current = null;
  for (const e of entries || []) {
    if (String(e).startsWith(SECTION_PREFIX)) {
      const raw = String(e).slice(SECTION_PREFIX.length);
      current = { name: normaliseSectionName(raw), raw_name: raw, header: String(e), symbols: [] };
      out.sections.push(current);
    } else if (current) current.symbols.push(e);
    else out.default.push(e);
  }
  return out;
}

/** Flatten back, preserving section order. PURE. */
export function flattenSections({ default: def, sections }) {
  return [...def, ...sections.flatMap((s) => [s.header, ...s.symbols])];
}

/**
 * Build the array to write: today's names in the default section, every
 * PRESERVED section carried through untouched.
 *
 * A symbol sitting in a preserved section is dropped from today's list rather
 * than appearing twice — TradingView rejects the whole write with 422 on a
 * duplicate, and the user putting it in KEEP is the stronger statement.
 */
export function buildWithPreserved(currentEntries, todaysSymbols, preserve = ['KEEP']) {
  const parsed = parseSections(currentEntries);
  const keepNames = new Set(preserve.map((p) => normaliseSectionName(p).toUpperCase()));
  const preserved = parsed.sections.filter((s) => keepNames.has(s.name.toUpperCase()));
  const protectedSymbols = new Set(preserved.flatMap((s) => s.symbols));
  return {
    entries: flattenSections({
      default: todaysSymbols.filter((s) => !protectedSymbols.has(s)),
      sections: preserved,
    }),
    protected_symbols: [...protectedSymbols],
    preserved_sections: preserved.map((s) => ({ name: s.name, count: s.symbols.length })),
    dropped_sections: parsed.sections.filter((s) => !keepNames.has(s.name.toUpperCase())).map((s) => s.name),
  };
}

/** Symbols under one named section. Case-insensitive, marker-insensitive. PURE. */
export function sectionSymbols(entries, name) {
  const want = normaliseSectionName(name).toUpperCase();
  const found = parseSections(entries).sections.find((s) => s.name.toUpperCase() === want);
  return found ? found.symbols.slice() : [];
}

/**
 * Build a watchlist split into ANY ordered set of managed sections.
 *
 * The general form. `buildBucketed` below is the two-bucket Weeks/Months case
 * expressed in terms of it — the owner's list now runs INTRADAY / WEEKLY /
 * MONTHLY, and a second copy of the KEEP-preservation logic is exactly the kind
 * of duplicate that drifts.
 *
 * Three invariants, each of which has already gone wrong somewhere:
 *
 *   - Any section whose name begins with KEEP is carried through UNTOUCHED, and
 *     its symbols outrank today's screen. Prefix matching, so "KEEP - POTENTIAL"
 *     and "KEEP - ACTIVE TRADE" both survive without being enumerated.
 *   - A symbol may appear ONCE. A duplicate anywhere makes TradingView reject the
 *     whole write with a 422, so earlier sections win and later ones drop it.
 *   - A managed section passed as `null` is CARRIED FORWARD rather than emptied.
 *     That is how a bucket on a slower cadence survives a daily run.
 *
 * @param {{name: string, symbols: string[]|null}[]} sections Ordered; null = carry forward.
 */
export function buildSectioned(currentEntries, { sections = [], keep_prefix = 'KEEP' } = {}) {
  const parsed = parseSections(currentEntries);
  const prefix = normaliseSectionName(keep_prefix).toUpperCase();
  const preserved = parsed.sections.filter((x) => x.name.toUpperCase().startsWith(prefix));
  const protectedSymbols = new Set(preserved.flatMap((x) => x.symbols));
  const existing = new Map(parsed.sections.map((x) => [x.name.toUpperCase(), x]));

  const used = new Set(protectedSymbols);
  const carried = [];
  const out = [];
  for (const want of sections) {
    const name = normaliseSectionName(want.name);
    const carriedForward = want.symbols === null;
    if (carriedForward) carried.push(name);
    const wanted = carriedForward ? sectionSymbols(currentEntries, name) : want.symbols;
    const kept = [];
    for (const sym of wanted || []) {
      if (used.has(sym)) continue;          // KEEP wins, then earlier sections
      used.add(sym);
      kept.push(sym);
    }
    // Reuse the header TradingView already holds, so rewriting a section does not
    // create a second one differing only by an invisible character.
    const header = existing.get(name.toUpperCase())?.header ?? sectionHeader(name);
    out.push({ name, header, symbols: kept });
  }

  const managed = new Set(sections.map((x) => normaliseSectionName(x.name)));
  return {
    entries: flattenSections({ default: [], sections: [...out, ...preserved] }),
    sections: Object.fromEntries(out.map((x) => [x.name, x.symbols])),
    carried_forward: carried,
    protected_symbols: [...protectedSymbols],
    preserved_sections: preserved.map((x) => ({ name: x.name, count: x.symbols.length })),
    // A section that existed and is neither managed nor KEEP would be deleted by
    // this write. Surfaced so a rename cannot quietly bin the user's own symbols.
    dropped_sections: parsed.sections
      .filter((x) => !x.name.toUpperCase().startsWith(prefix) && !managed.has(x.name))
      .map((x) => ({ name: x.name, count: x.symbols.length })),
    orphaned_default: parsed.default.slice(),
  };
}

/**
 * The two-bucket Weeks/Months case, expressed through `buildSectioned`.
 *
 * Pass `months: null` on a day the monthly bucket is NOT due — the existing
 * Months section is then carried forward verbatim. That is the cadence fix
 * expressed in the watchlist: on 20 of 21 weekdays it is not touched at all.
 *
 * Ordering is deliberate: Months first (slowest, most evidenced), then Weeks,
 * then the KEEP sections in whatever order they already had.
 */
export function buildBucketed(currentEntries, {
  weeks = [],
  months = null,
  keep_prefix = 'KEEP',
  months_section = 'Months',
  weeks_section = 'Weeks',
} = {}) {
  const r = buildSectioned(currentEntries, {
    keep_prefix,
    sections: [
      { name: months_section, symbols: months },
      { name: weeks_section, symbols: weeks },
    ],
  });
  return {
    entries: r.entries,
    months: r.sections[months_section],
    weeks: r.sections[weeks_section],
    months_carried_forward: r.carried_forward.includes(months_section),
    protected_symbols: r.protected_symbols,
    preserved_sections: r.preserved_sections,
    dropped_sections: r.dropped_sections,
    orphaned_default: r.orphaned_default,
  };
}

/** Run a fetch inside the page, where the session cookie applies. */
async function pageFetch(expr) {
  const res = await evaluate(expr, { awaitPromise: true });
  if (res?.err) throw new Error(res.err);
  return res;
}

/** Every custom list, with id and name. */
export async function listAll() {
  const res = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j||[]).map(function(x){ return { id:x.id, name:x.name, n:(x.symbols||[]).length, active:!!x.active }; }); })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (!Array.isArray(res)) throw new Error('Could not read the custom watchlists.');
  return res;
}

/**
 * Resolve a list by EXACT name.
 *
 * Case-sensitive and exact on purpose. A near-match is how you end up writing
 * twenty symbols over `TA_TradingView_Watchlist`.
 */
export async function findByName(name) {
  const all = await listAll();
  const hits = all.filter((l) => l.name === name);
  if (!hits.length) {
    throw new Error(`No watchlist named exactly "${name}". Found: ${all.map((l) => l.name).join(', ')}. `
      + 'Create it in TradingView first — this tool does not create lists.');
  }
  if (hits.length > 1) {
    throw new Error(`${hits.length} watchlists are named "${name}". Rename one — an ambiguous target is not safe to overwrite.`);
  }
  return hits[0];
}

/**
 * The symbols currently in the named list.
 *
 * The morning screen needs this BEFORE it rewrites: names dropping out of the
 * list keep their drawings otherwise, because the next run only visits names it
 * is about to draw on.
 */
export async function listContents(name) {
  const target = await findByName(name);
  const res = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? (l.symbols || []) : { err: "list vanished between reads" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (!Array.isArray(res)) throw new Error('Could not read the list contents.');
  return res;
}

/**
 * Replace the contents of the named list.
 *
 * `symbols` are full TradingView symbols ("NASDAQ:AAPL"). Duplicates are
 * removed first: TradingView rejects the entire write with 422 if any symbol
 * repeats, which would fail the run over one repeat.
 */
export async function rewrite({ name, symbols, dry_run = true, backup_dir = 'backups' }) {
  if (!name) throw new Error('A list name is required.');
  const clean = [...new Set((symbols || []).filter(Boolean))];
  if (!clean.length) throw new Error('Refusing to write an empty list — that would erase it with nothing to show.');

  const target = await findByName(name);

  // Read the current contents so the write can be backed up and verified.
  const before = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? { id:l.id, name:l.name, symbols:l.symbols||[] } : { err: "list vanished between reads" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);

  // RE-CONFIRM the id still belongs to that name, immediately before writing.
  if (before.name !== name) {
    throw new Error(`List ${target.id} is named "${before.name}", expected "${name}". Refusing to write.`);
  }

  if (dry_run) {
    return {
      success: true, dry_run: true, list: { id: target.id, name },
      would_write: clean.length, currently: before.symbols.length,
      removed: before.symbols.filter((s) => !clean.includes(s)).length,
      added: clean.filter((s) => !before.symbols.includes(s)).length,
      note: 'Nothing written. Pass dry_run: false to apply.',
    };
  }

  mkdirSync(backup_dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(backup_dir, `watchlist-${name.replace(/\W+/g, '_')}-${stamp}.json`);
  writeFileSync(backup, JSON.stringify({ id: target.id, name, symbols: before.symbols }, null, 2), 'utf8');

  await setListContents(target.id, clean, { current: before.symbols });

  // Verify by reading back, not by trusting the 200.
  const after = await pageFetch(`
    fetch("${TV}/api/v1/symbols_list/custom/", { credentials: "include" })
      .then(function(r){ return r.json(); })
      .then(function(j){ var l = (j||[]).filter(function(x){ return x.id === ${target.id}; })[0];
                         return l ? { name:l.name, n:(l.symbols||[]).length } : { err:"gone" }; })
      .catch(function(e){ return { err: String(e) }; })
  `);
  if (after.n !== clean.length) {
    throw new Error(`Wrote ${clean.length} symbols but the list now holds ${after.n}. `
      + `Previous contents are backed up at ${backup}.`);
  }

  return {
    success: true, applied: true, verified: true,
    list: { id: target.id, name },
    entries_before: before.symbols.length,
    entries_after: after.n,
    backup,
    note: 'Full replace. Only the list matching this exact name was touched.',
  };
}

/**
 * Force TradingView's watchlist panel to show what the server actually holds.
 *
 * ── Why this is required, not cosmetic ──
 *
 * The panel caches its contents and there is no event that invalidates them
 * when the list changes through REST. The MCP writes by running JS INSIDE the
 * TradingView page, so the app is by definition open during every write — this
 * is not an occasional condition that resolves itself, it happens on every
 * single run.
 *
 * Proven rather than assumed:
 *
 *   before write   panel 20   server 20     in sync
 *   after write    panel 20   server 15     stale
 *   after reload   panel 15                 correct, ~4s
 *
 * A reload is safe. Drawings persist server-side — the evidence is that 545
 * orphaned shapes survived TradingView restarts, which is the entire reason
 * clear-orphans exists. Verified again here: a chart carrying 21 shapes still
 * had all 21 afterwards.
 */
export async function refreshPanel({ expect = null, timeout_ms = 45_000 } = {}) {
  const started = Date.now();
  try { await evaluate('location.reload()'); } catch { /* the page goes away mid-call */ }

  while (Date.now() - started < timeout_ms) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const n = await evaluate("document.querySelectorAll('[class*=\"symbolNameText\"]').length");
      if (typeof n === 'number' && n > 0) {
        return {
          success: true, rows: n, waited_ms: Date.now() - started,
          matches_expected: expect == null ? null : n === expect,
          ...(expect != null && n !== expect
            ? { note: `Panel shows ${n} but ${expect} were written — it may still be settling.` }
            : {}),
        };
      }
    } catch { /* still reloading */ }
  }
  return { success: false, waited_ms: Date.now() - started,
    note: 'The panel did not come back in time. The list IS written; re-select it in TradingView to see it.' };
}

