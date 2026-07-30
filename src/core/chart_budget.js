/**
 * The chart's indicator budget.
 *
 * The owner keeps a deliberately sparse chart: **Volume** and **Moving Average
 * Ribbon** are permanent, and the total is capped at five studies. So at most
 * THREE may be added, and the two permanent ones must never be removed to make
 * room.
 *
 * This exists because `chart_indicators_for_strategy` drives studies from the
 * catalogue, and several strategies name four or five — `momentum_pullback` names
 * five on its own. Without a budget the tool would silently blow past the cap on
 * a live chart.
 *
 * ── Why it refuses rather than truncating ──
 *
 * This repo's rule is that a silent cap reads as "covered everything" when it did
 * not. So when a strategy names more studies than fit, the ones that were DROPPED
 * are named, in priority order, and the caller is told what to do about it —
 * rather than quietly adding the first three and reporting success.
 *
 * All pure.
 */

/** Never removed, never counted against what a strategy may add. */
export const PERMANENT_STUDIES = Object.freeze(['Volume', 'Moving Average Ribbon']);

/** Total studies allowed on the chart, permanent ones included. */
export const MAX_STUDIES = 5;

/**
 * What the permanent studies ALREADY plot, so a strategy naming one of them does
 * not burn a slot re-adding it.
 *
 * The owner's Moving Average Ribbon (`STD;MA%Ribbon`) has four MA slots and two are
 * enabled: SMA 50 (`in_8`) and SMA 200 (`in_13`). The EMA 8 and EMA 100 slots are
 * off. So the chart always carries Volume, MA 50 and MA 200 — and adding a separate
 * `Moving Average` at length 50 or 200 is a duplicate that costs one of only three
 * free slots. This was found by doing exactly that.
 */
export const PERMANENT_COVERS = Object.freeze([
  { study: 'Moving Average', lengths: Object.freeze([50, 200]), by: 'Moving Average Ribbon' },
]);

const norm = (s) => String(s || '').trim().toLowerCase();

/** Is this study one the owner keeps permanently? */
export function isPermanent(name) {
  return PERMANENT_STUDIES.some((p) => norm(p) === norm(name));
}

/**
 * Is this wanted indicator already plotted by one of the permanent studies?
 * Returns the covering study's name, or null.
 *
 * Matching is on the study name AND the period, because `Moving Average` at length
 * 20 is genuinely absent while length 50 is genuinely present.
 */
export function coveredByPermanent(want, studies = []) {
  const study = want && typeof want === 'object' ? want.study : want;
  if (!study) return null;
  const length = want && typeof want === 'object'
    ? (want.inputs?.length ?? want.length ?? null)
    : null;
  const names = (studies || []).map((s) => norm(s.name || s));
  for (const c of PERMANENT_COVERS) {
    if (norm(c.study) !== norm(study)) continue;
    if (!names.includes(norm(c.by))) continue; // the coverer must actually be present
    if (length != null && c.lengths.includes(Number(length))) return c.by;
    /**
     * No period given is ambiguous, and it is NOT treated as covered. A duplicate MA
     * is visible on the chart and self-correcting; a silent omission is invisible.
     * Catalogue entries always carry `inputs.length`, so this branch is rare.
     */
  }
  return null;
}

/**
 * How many studies may still be added, given what is on the chart now.
 * `studies` is `chart_get_state().studies`.
 */
export function budget(studies = []) {
  const names = (studies || []).map((s) => s.name || s);
  const permanent = names.filter(isPermanent);
  const other = names.filter((n) => !isPermanent(n));
  const missingPermanent = PERMANENT_STUDIES.filter((p) => !names.some((n) => norm(n) === norm(p)));

  return {
    on_chart: names.length,
    max_studies: MAX_STUDIES,
    permanent_present: permanent,
    missing_permanent: missingPermanent,
    removable: other,
    slots_free: Math.max(0, MAX_STUDIES - names.length),
    slots_if_cleared: Math.max(0, MAX_STUDIES - permanent.length),
    ...(missingPermanent.length ? {
      warning: `${missingPermanent.join(' and ')} should always be on this chart and ${missingPermanent.length > 1 ? 'are' : 'is'} not. `
        + 'Add it back rather than using the free slot for something else.',
    } : {}),
  };
}

/**
 * Decide what to add, honouring the cap.
 *
 * `wanted` is the strategy's indicator list. Priority is the order the catalogue
 * gives them, which is the order the strategy's own rules reference them.
 *
 * `clear_added` frees the non-permanent slots first — for moving from one
 * strategy's indicators to another's without hitting the cap.
 */
export function planIndicators(wanted = [], studies = [], { clear_added = false } = {}) {
  const b = budget(studies);
  const names = (studies || []).map((s) => s.name || s);

  // Already on the chart: neither added nor counted against the budget.
  const already = [];
  const candidates = [];
  for (const w of wanted) {
    const study = w && typeof w === 'object' ? w.study : w;
    if (!study || w?.external) { candidates.push(w); continue; }
    if (names.some((n) => norm(n) === norm(study))) { already.push(w); continue; }
    // A permanent study may already plot it under a different name — the MA Ribbon
    // carries SMA 50 and SMA 200, so re-adding either would waste a slot.
    const cover = coveredByPermanent(w, studies);
    if (cover) { already.push({ ...(typeof w === 'object' ? w : { study: w }), covered_by: cover }); continue; }
    candidates.push(w);
  }

  const toRemove = clear_added
    ? (studies || []).filter((s) => !isPermanent(s.name || s))
    : [];
  const freeAfterClear = clear_added ? b.slots_if_cleared : b.slots_free;

  const fits = candidates.slice(0, Math.max(0, freeAfterClear));
  const dropped = candidates.slice(Math.max(0, freeAfterClear));

  return {
    budget: b,
    already_on_chart: already,
    will_remove: toRemove.map((s) => ({ name: s.name || s, entity_id: s.id })),
    will_add: fits,
    dropped,
    ...(dropped.length ? {
      dropped_note: `${dropped.length} indicator(s) did NOT fit the ${MAX_STUDIES}-study cap and were NOT added: `
        + `${dropped.map((d) => (typeof d === 'object' ? d.label || d.study : d)).join(', ')}. `
        + 'They are named rather than silently skipped. Pass clear_added:true to free the non-permanent slots, or read '
        + 'the values with data_get_study_values from a separate pass.',
    } : {}),
    ...(freeAfterClear === 0 ? {
      no_room: `The chart is at the ${MAX_STUDIES}-study cap with nothing removable. `
        + `${PERMANENT_STUDIES.join(' and ')} are permanent and will not be removed.`,
    } : {}),
  };
}
