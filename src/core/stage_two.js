/**
 * STAGE 2: this repo's own detectors, applied to the scanner's output.
 *
 * `docs/screening.md` states the design — "TV scanner as coarse filter, our
 * detectors as verdict" — but until now the detectors ran only on the twenty names
 * the merge had already chosen. The scanner picked the list; our measurements only
 * described it afterwards. The owner's instruction closes that: the detectors run
 * BEFORE the per-scanner cut, so the five that reach the watchlist are five that
 * SURVIVED, not five the scanner happened to rank highest.
 *
 * ── What can reject, and what deliberately cannot ──
 *
 * A gate is only worth having if it abstains sometimes. These do:
 *
 *   - `market_regime.tradeable` — efficiency against the random-walk baseline.
 *     A choppy reading is the repo's own gate saying do not hunt, and it is the
 *     single most common rejection.
 *   - `ourAssessment().tradeable` — the composite verdict, which folds in a stale
 *     last leg, a partial weekly bar, and no measurable persistence.
 *   - Bars at all. A symbol that will not load is not a candidate.
 *
 * What does NOT gate, on purpose:
 *
 *   - Pattern presence. 68% of random walks contain a structural pattern, and the
 *     screens already select for shape. Requiring one would filter on noise.
 *   - `stage_plan` alignment. Forward-tested NEGATIVE as a gate — long 33.5% vs a
 *     36.4% baseline. It describes; it must not select.
 *   - Two-leader group agreement. Measured: costs 9.3 points of win rate.
 *
 * Every rejection carries its reason, so a thin tier is explainable rather than
 * mysterious.
 */
import { assess, ourAssessment } from './assessment.js';

/**
 * Run the detectors on one symbol's bars.
 *
 * @returns {{passed: boolean, why: string, assessment: object, verdict: object, score: number}}
 */
export function stageTwo(bars, { min_bars = 60 } = {}) {
  if (!Array.isArray(bars) || bars.length < min_bars) {
    return {
      passed: false,
      why: `only ${bars?.length ?? 0} bars (need ${min_bars}) — not enough history to measure anything`,
      assessment: null,
      verdict: null,
      score: 0,
    };
  }

  const a = assess(bars, null);
  const v = ourAssessment(a);

  const reasons = [];
  if (a.market_regime && a.market_regime.tradeable === false) {
    reasons.push(`choppy regime (efficiency ${a.market_regime.efficiency} vs random-walk `
      + `${a.market_regime.random_walk_efficiency}) — the gate says do not hunt`);
  }
  if (v && v.tradeable === false && !reasons.length) {
    reasons.push(`our assessment says not tradeable: ${(v.cautions || []).join('; ') || 'no reason given'}`);
  }

  /**
   * The rank among survivors. Deliberately NOT a predictive score — it orders
   * candidates for a limited number of slots, nothing more.
   *
   * Conviction and bias come from `ourAssessment`, which is built from the
   * measurements rather than from adjectives. Confluence across screens is added
   * by the caller, which is the only place that knows it.
   */
  const convictionScore = { HIGH: 3, MEDIUM: 2, LOW: 1 }[String(v?.conviction || '').toUpperCase()] ?? 0;
  const factors = (v?.bullish_factors?.length || 0) + (v?.bearish_factors?.length || 0);
  const cautions = v?.cautions?.length || 0;
  const score = convictionScore * 10 + factors - cautions;

  return {
    passed: reasons.length === 0,
    why: reasons.length ? reasons.join(' | ') : 'passed the detector gate',
    assessment: a,
    verdict: v,
    score,
    bias: v?.bias ?? null,
    conviction: v?.conviction ?? null,
  };
}

/**
 * Rank survivors and take the top N.
 *
 * `confluence` — how many screens a symbol appeared in — breaks ties. It is
 * reported rather than weighted heavily: appearing in several screens means
 * several coarse filters liked it, which is worth noting and is not evidence.
 */
export function topSurvivors(entries, n = 5) {
  return [...entries]
    .filter((e) => e.stage2?.passed)
    .sort((a, b) => (b.stage2.score - a.stage2.score)
      || ((b.screens?.length || 0) - (a.screens?.length || 0))
      || String(a.symbol).localeCompare(String(b.symbol)))
    .slice(0, n);
}
