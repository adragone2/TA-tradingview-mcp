/**
 * Which execution tier a candidate belongs to: INTRADAY, WEEKLY or MONTHLY.
 *
 * The watchlist has one section per tier, so every candidate needs exactly one —
 * and a symbol routinely passes screens implying different ones. DLO passes
 * `volatility_contraction` (whose strategy is monthly) and `group_leadership`
 * (also monthly); a name passing `breakout` and `short_term_reversal` implies
 * monthly and weekly at once.
 *
 * ── The rule, and why ──
 *
 * 1. The tier comes from the STRATEGY, not the screen. `strategies.json` carries
 *    an `execution` field per strategy; a screen only points at strategies.
 * 2. Best EVIDENCE TIER wins. A Tier B strategy's horizon beats a Tier C one's —
 *    the tier is a statement about how well the idea is supported, so it should
 *    decide which horizon the name is filed under.
 * 3. On a tie, the LONGER horizon wins. Below ~21 trading days the documented
 *    effect is REVERSAL, and almost every structural setup here is a continuation
 *    bet — so filing a tie as weekly puts a continuation idea on the side of the
 *    sign change where it is weakest. Monthly is the safer default.
 * 4. REJECTED strategies never decide a tier. Six catalogue entries are kept
 *    deliberately as refuted; routing on one would file a name by an idea this
 *    repo has measured to have no edge.
 *
 * Pure.
 */

export const TIERS = Object.freeze(['intraday', 'weekly', 'monthly']);

/** Longer is safer on a tie — see rule 3. */
const TIER_RANK = Object.freeze({ intraday: 0, weekly: 1, monthly: 2 });

/** A→best. Anything unrecognised sorts last. */
const EVIDENCE_RANK = Object.freeze({ A: 0, B: 1, C: 2 });
const evidenceOf = (t) => (EVIDENCE_RANK[String(t || '').toUpperCase()] ?? 9);

/**
 * @param {object[]} strategies  The strategies the passing screens implied, each
 *                               with `name`, `execution` and `evidence_tier`.
 * @returns {{tier: string|null, basis: string, from: object|null, rejected_ignored: string[]}}
 */
export function classifyTier(strategies = []) {
  const usable = (strategies || []).filter(
    (s) => s && TIERS.includes(String(s.execution || '').toLowerCase()),
  );
  const rejected = usable.filter((s) => String(s.evidence_tier).toUpperCase() === 'REJECTED');
  const eligible = usable.filter((s) => String(s.evidence_tier).toUpperCase() !== 'REJECTED');

  if (!eligible.length) {
    return {
      tier: null,
      basis: rejected.length
        ? `Only REJECTED strategies matched (${rejected.map((s) => s.name).join(', ')}). Each has been `
          + 'measured to have no edge over its own null, so none may decide a tier.'
        : 'No strategy with a recognised execution tier matched.',
      from: null,
      rejected_ignored: rejected.map((s) => s.name),
    };
  }

  const sorted = [...eligible].sort((a, b) => {
    const ev = evidenceOf(a.evidence_tier) - evidenceOf(b.evidence_tier);
    if (ev !== 0) return ev;
    // Tie on evidence: the LONGER horizon wins.
    return TIER_RANK[String(b.execution).toLowerCase()] - TIER_RANK[String(a.execution).toLowerCase()];
  });

  const win = sorted[0];
  const tier = String(win.execution).toLowerCase();
  const tied = eligible.filter((s) => evidenceOf(s.evidence_tier) === evidenceOf(win.evidence_tier));
  const spread = new Set(tied.map((s) => String(s.execution).toLowerCase()));

  return {
    tier,
    from: { strategy: win.name, evidence_tier: win.evidence_tier, execution: tier },
    basis: spread.size > 1
      ? `${tied.length} strategies tie at evidence tier ${win.evidence_tier} across `
        + `${[...spread].join('/')}; the LONGER horizon wins because below ~21 trading days the `
        + 'documented effect is reversal and these are continuation bets.'
      : `${win.name} is the best-evidenced match (tier ${win.evidence_tier}), and it executes ${tier}.`,
    considered: eligible.map((s) => ({ name: s.name, tier: s.evidence_tier, execution: s.execution })),
    rejected_ignored: rejected.map((s) => s.name),
  };
}

/** Section name for a tier. Matches the watchlist the owner keeps. */
export const SECTION_FOR = Object.freeze({
  intraday: 'INTRADAY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
});

/** Sections this routine rewrites; anything starting KEEP is never touched. */
export const MANAGED_SECTIONS = Object.freeze(['INTRADAY', 'WEEKLY', 'MONTHLY']);
export const KEEP_PREFIX = 'KEEP';
