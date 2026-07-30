/**
 * Industry-group context, and Livermore's "Key Price" two-leader confirmation.
 *
 * This is the one part of his system with no equivalent anywhere in this repo.
 * `relative_strength` compares a symbol to an INDEX; `position_correlation`
 * compares holdings to each other. Neither answers the two questions Livermore
 * asked before every trade:
 *
 *   1. Is this stock's GROUP moving?
 *   2. Does the SISTER STOCK — the other leader of that group — agree?
 *
 * > "Livermore never tracked a single stock. He first tracked the industry group
 * >  movements... a legitimate group movement had to include at least the two
 * >  leaders of the group, and eventually all the stocks in the group would follow."
 *
 * ── The Key Price, and what it actually says ──
 *
 * Chapter 11 is Livermore's own 1940 text, and it gives the rule a mechanic:
 *
 * > "I do not take the action of a single stock as an indication that the trend has
 * >  been positively changed for that group. Instead I take the combined action of
 * >  TWO STOCKS in any group... There is danger of being caught in a false movement
 * >  by depending upon only one stock."
 *
 * His threshold was six points per stock, so twelve combined. Note what that
 * makes it: requiring the SUM of two moves to clear 2x a bar is the same as
 * requiring their AVERAGE to clear the bar. So the Key Price is an AVERAGE of two
 * leaders — more permissive than demanding both clear it individually, less noisy
 * than trusting either alone. He says so himself: U.S. Steel moving 5-1/8 counts
 * if Bethlehem moved 7. That is the whole content of the rule and it is worth
 * being explicit about, because "combined" reads like a stricter test than it is.
 *
 * ── What is deliberately NOT copied ──
 *
 * His six POINTS. On a $30 stock that is 20% — a 1940 artefact from a market
 * where he traded $100+ rails, and he half-admits it: "certain adjustments in the
 * formula must be made in considering the very low-priced issues." The threshold
 * here is a PERCENTAGE, and the default is a swing-scale number rather than his
 * major-move one. `LIVERMORE_POINT_NOTE` records the conversion.
 *
 * ── Sector is not Group ──
 *
 * He is explicit that people conflate them, and the TradingView scanner happens
 * to give both: `sector` is his Sector (Electronic Technology) and `industry` is
 * his Group (Semiconductors). The GROUP is the one his rule operates on.
 *
 * Everything except `fetchGroupRows` is pure.
 */
import { scan } from './scanner.js';

const round = (n, dp = 3) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Columns needed to resolve a group and rank its leaders. */
export const GROUP_COLUMNS = Object.freeze([
  // `description` is the COMPANY name ("Alphabet Inc. Class C"); `name` is just
  // the ticker. Dual-class dedup needs the former — see dedupeShareClasses.
  'name', 'description', 'close', 'sector', 'industry', 'market_cap_basic',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'SMA50', 'SMA200', 'average_volume_10d_calc',
]);

/** Strip a share-class suffix so two listings of one company collapse. */
export const issuerOf = (row) => String(row?.description || row?.name || '')
  .replace(/\s+(Class|Cl\.?|Series)\s+[A-Z0-9]$/i, '')
  .replace(/\s+-\s+Class\s+[A-Z0-9]$/i, '')
  .trim()
  .toLowerCase();

/**
 * Collapse dual share classes to one row, keeping the larger listing.
 *
 * This is not cosmetic. GOOG and GOOGL are one company, and treating them as a
 * group's "two leaders" makes the Key Price a tautology — they confirm each other
 * on essentially every bar. Measured before this fix: GOOG/GOOGL produced 57 solo
 * signals and 57 tandem-confirmed, a 100% confirmation rate that inflated the
 * tandem arm with a fake agreement.
 *
 * Two independent signals, because either alone misses cases:
 *   - the issuer name with any Class/Series suffix stripped
 *   - a market capitalisation that matches to within rounding. Dual classes report
 *     the SAME company cap (Alphabet: ...698.0005 and ...697.9995).
 */
export function dedupeShareClasses(rows) {
  const out = [];
  const seenIssuer = new Map();
  for (const r of (rows || [])) {
    const issuer = issuerOf(r);
    const cap = Number(r.market_cap_basic);
    const dupIndex = out.findIndex((k) => {
      if (issuer && issuerOf(k) === issuer) return true;
      const kc = Number(k.market_cap_basic);
      if (!Number.isFinite(cap) || !Number.isFinite(kc) || cap <= 0) return false;
      return Math.abs(cap - kc) / cap < 1e-6;
    });
    if (dupIndex === -1) { out.push(r); seenIssuer.set(issuer, true); continue; }
    // Keep whichever listing is larger; ties keep the incumbent.
    if (Number(r.market_cap_basic || 0) > Number(out[dupIndex].market_cap_basic || 0)) out[dupIndex] = r;
  }
  return out;
}

export const LIVERMORE_POINT_NOTE = Object.freeze({
  original: 'Six points from the extreme on a stock above $30, so twelve points combined for the two leaders.',
  problem: 'Six points on a $30 stock is 20%. It is a 1940 point-based rule from a market of $100+ rails, and it is '
    + 'a MAJOR-move threshold, not a swing one.',
  what_we_do: 'The threshold is a percentage. The default (6%) is swing-scale; pass 20 to reproduce his major-move bar.',
  his_own_caveat: '"Certain adjustments in the formula must be made in considering the very low-priced issues."',
});

/** Windows the scanner gives us, mapped to a horizon label. */
export const PERF_WINDOWS = Object.freeze({ 'Perf.W': 'week', 'Perf.1M': 'month', 'Perf.3M': 'quarter' });

/**
 * Fetch every row needed to build group context for a universe.
 * One scan, because a scan per symbol would be dozens of requests.
 */
export async function fetchGroupRows({ universe = ['sp500'], limit = 500, timeout_ms = 25_000 } = {}) {
  const r = await scan({
    columns: GROUP_COLUMNS,
    universe,
    range: [0, limit],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    timeout_ms,
  });
  return { rows: r.rows || [], universe, fetched: (r.rows || []).length };
}

/** Bare ticker from a scanner symbol like "NASDAQ:AAPL". */
export const bare = (s) => String(s || '').split(':').pop().toUpperCase();

/** Find one symbol's row, matching on the bare ticker. */
export function findRow(rows, symbol) {
  const want = bare(symbol);
  return (rows || []).find((r) => bare(r.symbol) === want) || null;
}

/**
 * Members of a group, ranked by market cap.
 *
 * `group` is the scanner's `industry` — Livermore's Group. Ranking by cap is a
 * choice: he says "the prominent stocks of the day, the leaders", and the two
 * biggest names is the least arbitrary reading of that available from this data.
 * `rank_by` can be switched to a performance window instead.
 */
export function groupMembers(rows, group, { rank_by = 'market_cap_basic' } = {}) {
  const members = dedupeShareClasses(
    (rows || []).filter((r) => r.industry === group && Number.isFinite(Number(r.close))),
  );
  return members.sort((a, b) => Number(b[rank_by] || 0) - Number(a[rank_by] || 0));
}

/**
 * The two leaders. Two because that is his rule, not because two is optimal.
 *
 * His stated exception: when one name is more than half the group's sales, one
 * will do — "sooner or later the rest of the group must follow the single
 * dominant leader." We cannot see sales, so market-cap share is the proxy, and
 * `dominant` says when it applies rather than silently changing the rule.
 */
export function groupLeaders(members, { count = 2, dominance_pct = 50 } = {}) {
  const list = members || [];
  const totalCap = list.reduce((a, r) => a + Number(r.market_cap_basic || 0), 0);
  const leaders = list.slice(0, Math.max(1, count));
  const topShare = totalCap > 0 ? (Number(leaders[0]?.market_cap_basic || 0) / totalCap) * 100 : null;
  return {
    leaders,
    members_considered: list.length,
    top_cap_share_pct: round(topShare, 1),
    dominant: topShare !== null && topShare >= dominance_pct
      ? {
          symbol: bare(leaders[0]?.symbol),
          share_pct: round(topShare, 1),
          note: `${bare(leaders[0]?.symbol)} is ${round(topShare, 1)}% of the group by market cap. Livermore: when one `
            + 'name dominates, one stock will do, because the rest of the group must follow it. Cap share is a PROXY '
            + 'for his "over 50 percent of the total sales of the group" — we cannot see sales.',
        }
      : null,
  };
}

/**
 * THE KEY PRICE.
 *
 * Combined move of the two leaders against 2x the threshold — equivalently their
 * AVERAGE against the threshold, which is what it really is.
 *
 * `window` is one of PERF_WINDOWS. Direction is taken from the sign of the
 * average, and `agree` reports whether both leaders point the same way, because
 * an average can clear the bar on one leader alone and that is a materially
 * weaker signal than both moving together.
 */
export function keyPrice(leaders, { window = 'Perf.1M', threshold_pct = 6 } = {}) {
  const pair = (leaders || []).slice(0, 2);
  if (pair.length < 2) {
    return {
      available: false,
      note: `The Key Price needs TWO leaders; found ${pair.length}. Livermore's whole point is that one stock can be `
        + 'a false movement.',
    };
  }
  // Number(null) is 0, so a missing figure would read as a 0% move rather than
  // as unknown — the same trap that made an absent stage report as "Stage 0".
  const raw = pair.map((r) => r[window]);
  const moves = raw.map((v) => (v === null || v === undefined || v === '' ? NaN : Number(v)));
  if (!moves.every((m) => Number.isFinite(m))) {
    return { available: false, note: `Missing ${window} for one of the leaders, so the Key Price is unknown, not zero.` };
  }

  const combined = moves[0] + moves[1];
  const average = combined / 2;
  const bar = Math.abs(Number(threshold_pct));
  const clears = Math.abs(average) >= bar;
  const bothSameSign = Math.sign(moves[0]) === Math.sign(moves[1]) && moves[0] !== 0;

  return {
    available: true,
    window,
    horizon: PERF_WINDOWS[window] || window,
    leaders: pair.map((r, i) => ({ symbol: bare(r.symbol), name: r.name, move_pct: round(moves[i], 2) })),
    combined_move_pct: round(combined, 2),
    average_move_pct: round(average, 2),
    threshold_pct: bar,
    combined_threshold_pct: bar * 2,
    clears_key_price: clears,
    direction: average > 0 ? 'up' : average < 0 ? 'down' : 'flat',
    leaders_agree: bothSameSign,
    verdict: !clears
      ? `The Key Price is NOT met: the two leaders averaged ${round(average, 2)}% over the ${PERF_WINDOWS[window] || window}, `
        + `below the ${bar}% bar. Livermore would not call the group's trend changed.`
      : bothSameSign
        ? `Key Price MET and both leaders agree — ${round(moves[0], 2)}% and ${round(moves[1], 2)}%. This is the `
          + 'confirmation he required before trading anything in the group.'
        : `Key Price met on the AVERAGE (${round(average, 2)}%) but the leaders DISAGREE in direction `
          + `(${round(moves[0], 2)}% vs ${round(moves[1], 2)}%). One leader is carrying it. That is the "false movement `
          + 'from one stock" case his rule exists to catch, so treat it as unconfirmed.',
    how_it_works: 'Requiring the SUM of two moves to clear 2x a bar is the same as requiring their AVERAGE to clear it. '
      + 'So the Key Price is an average of two leaders — more permissive than demanding both clear it, less noisy than '
      + 'either alone. leaders_agree is what distinguishes the two cases.',
  };
}

/**
 * The sick stock in a healthy group.
 *
 * > "if a particular stock in the favored group did not move up and prosper with
 * >  the others, this could mean that perhaps this particular stock was weak or
 * >  sick, and therefore might be a good short sale."
 *
 * His own worked example: after war was declared in Europe every prominent group
 * recovered to new highs except Steel. Four months later it emerged the English
 * government had sold 100,000 shares of U.S. Steel. He never knew why at the
 * time and did not need to.
 */
export function laggards(members, { window = 'Perf.1M', min_gap_pct = 5 } = {}) {
  const withMove = (members || []).filter((r) => Number.isFinite(Number(r[window])));
  if (withMove.length < 3) return { available: false, note: 'Need at least 3 members with a performance figure.' };

  const moves = withMove.map((r) => Number(r[window]));
  const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];

  const behind = withMove
    .map((r) => ({ symbol: bare(r.symbol), name: r.name, move_pct: round(Number(r[window]), 2), gap_pct: round(Number(r[window]) - median, 2) }))
    .filter((x) => x.gap_pct <= -Math.abs(min_gap_pct))
    .sort((a, b) => a.gap_pct - b.gap_pct);

  return {
    available: true,
    window,
    group_median_move_pct: round(median, 2),
    laggards: behind,
    note: behind.length
      ? `${behind.length} member(s) are at least ${min_gap_pct} points behind the group median. Livermore read that as `
        + 'weak or sick — a short candidate, or at minimum a reason not to buy it. He did not need to know why.'
      : 'No member is materially behind the group median.',
  };
}

/**
 * Top Down Trading — his four ordered steps, as a GATE.
 *
 * Order matters and he is emphatic about it: market, then group, then the two
 * leaders in tandem, then the individual name. Each argument is a direction
 * ('up' | 'down' | 'flat' | null) supplied by the caller from whatever tool
 * measured it, so this stays pure and does not silently pick its own trend
 * definitions.
 */
export function topDownGate({ market = null, group = null, key_price = null, side = null } = {}) {
  const steps = [];
  const dirOk = (d) => d === 'up' || d === 'down';

  steps.push({
    step: 1,
    name: 'line of least resistance (the market this stock trades on)',
    value: market,
    pass: dirOk(market),
    why: 'Shannon and Livermore agree here: trade with the trend of the market the stock actually trades on. He was '
      + 'explicit about checking the RIGHT one — Dow versus Nasdaq versus Amex.',
  });
  steps.push({
    step: 2,
    name: 'industry group direction',
    value: group,
    pass: dirOk(group),
    why: 'Group movement is his Discovery 2 — the key to individual stock movement.',
  });
  steps.push({
    step: 3,
    name: 'Key Price — two leaders confirm',
    value: key_price?.available ? (key_price.clears_key_price ? key_price.direction : 'not met') : 'unknown',
    pass: !!(key_price?.available && key_price.clears_key_price && key_price.leaders_agree),
    why: 'Two stocks, not one. "There is danger of being caught in a false movement by depending upon only one stock."',
  });

  const aligned = [market, group, key_price?.clears_key_price ? key_price.direction : null];
  const dirs = new Set(aligned.filter(dirOk));
  const allAgree = dirs.size === 1 && steps.every((s) => s.pass);
  const direction = allAgree ? [...dirs][0] : null;
  const inferredSide = direction === 'up' ? 'long' : direction === 'down' ? 'short' : null;

  if (side && inferredSide && side !== inferredSide) {
    return {
      gate: 'CLOSED',
      steps,
      direction,
      side: null,
      reason: `Requested side "${side}" contradicts the aligned direction (${direction}), which licenses ${inferredSide} only.`,
    };
  }

  return {
    gate: allAgree ? 'OPEN' : 'CLOSED',
    steps,
    steps_passed: steps.filter((s) => s.pass).length,
    direction,
    side: allAgree ? inferredSide : null,
    reason: allAgree
      ? `All three levels point ${direction}, and the two group leaders agree. This is the "preponderance of evidence" `
        + 'he required before pulling the trigger.'
      : steps.some((st) => !st.pass)
        ? `${steps.filter((st) => !st.pass).length} of 3 levels did not confirm: `
          + `${steps.filter((st) => !st.pass).map((st) => st.name).join('; ')}. `
          + 'He would sit in cash. "No trader can or should play the market all the time."'
        : `Every level confirmed individually, but they point in DIFFERENT DIRECTIONS `
          + `(market ${market}, group ${group}, leaders ${key_price?.direction}). That is a conflict, not a failed `
          + 'check, and it is exactly when he sat in cash: "when there are mixed trend signals... revert to a more '
          + 'cautious mode until trends begin to align."',
    what_this_is_not: 'A gate is not an edge. This repo has already measured one alignment gate (stage_plan) that '
      + 'filtered well and made forward outcomes WORSE. Nothing here has been forward-tested — see '
      + 'GROUP_LEAD_LAG_STUDY.',
  };
}

/**
 * The lead-lag claim, measured. `node scripts/group-lead-lag.js` re-measures.
 *
 * He claims groups turn BEFORE the market, by three to six months:
 * > "The signals from these stocks came three to six months before the entire
 * >  market followed suit."
 *
 * Filled in by the script. Until it has a number, every group tool must say the
 * claim is unmeasured rather than implying it is established.
 */
/**
 * THE SISTER-STOCK CLAIM, MEASURED — and it does not survive.
 * `node scripts/group-lead-lag.js` re-measures.
 *
 * Livermore's stated reason for the Key Price is that one stock can be a false
 * movement. That is falsifiable, so it was tested: a new 40-bar closing high on
 * leader A, labelled forward with triple-barrier, against the same signals
 * filtered to those where leader B also made a new high at or before the same bar.
 *
 *   SOLO    544 signals,  91 independent, 30.9% win rate
 *   TANDEM  228 signals,  56 independent, 21.6% win rate      -9.3 points, z -2.57
 *
 * Requiring the sister stock discarded 58% of signals and made the survivors
 * WORSE. That is an argument against the rule as a filter, not merely an absence
 * of support for it.
 *
 * ── A bug worth recording, because fixing it strengthened the result ──
 *
 * The first run showed -5.6 points at z -1.64. It was wrong: GOOG and GOOGL were
 * being treated as a group's two leaders, and they are one company. They confirmed
 * each other on 57 of 57 signals — a tautology padding the tandem arm with fake
 * agreements. With `dedupeShareClasses` in place the pair became GOOG/META and the
 * effect went to -9.3 at z -2.57. A data-quality bug was hiding a real result.
 *
 * ── Why this is coherent ──
 *
 * Requiring two large names in one group to break out within days of each other
 * selects for moves that are already extended and already correlated. It is the
 * same failure as `stage_plan`: a confirmation rule describes what has ALREADY
 * happened, and below ~21 trading days the documented effect is reversal. This is
 * now the THIRD alignment or confirmation gate measured here and the third to fail
 * — after level_pressure's out-of-sample collapse and the stage gate's negative
 * forward test.
 */
export const TANDEM_CONFIRMATION_STUDY = Object.freeze({
  status: 'MEASURED — NEGATIVE',
  claim: 'Livermore ch. 11: "There is danger of being caught in a false movement by depending upon only one stock. '
    + 'The movement of the two stocks combined gives reasonable assurance."',
  method: 'New 40-bar closing high on leader A as the signal; triple-barrier forward labels (target 3x vol, stop 1.5x, '
    + 'time 20 bars). TANDEM is the SUBSET where leader B also made a new high AT OR BEFORE the same bar — a forward '
    + 'confirmation window would be reading the future.',
  universe: '14 S&P 500 industry groups, two leaders each by market cap, daily bars.',
  solo: { signals: 544, independent: 91, win_rate_pct: 30.9 },
  tandem: { signals: 228, independent: 56, win_rate_pct: 21.6 },
  lift_points: -9.3,
  z: -2.57,
  signals_discarded_pct: 58.1,
  verdict: 'THE SISTER STOCK HURTS. It discarded 58% of signals and the survivors won 9.3 points LESS often. Use group '
    + 'context to describe where a name sits in its group; do NOT use two-leader agreement as a filter that improves '
    + 'outcomes.',
  bug_that_hid_it: 'The first run gave -5.6 at z -1.64 because GOOG and GOOGL were being used as a group of two '
    + 'leaders. One company, 57 of 57 tautological confirmations. dedupeShareClasses fixed it and the effect grew.',
  why_it_is_coherent: 'Two large names in one group breaking out within days of each other selects for moves that are '
    + 'already extended and already correlated — the same "it already happened" problem that made stage_plan negative. '
    + 'Third confirmation gate measured in this repo, third to fail.',
  caveats: [
    'z is computed on RAW overlapping counts and is optimistic; 56 independent tandem events is adequate but not large.',
    'One universe (S&P 500), one period, ~300 bars per symbol. No out-of-sample arm — and this repo has learned that '
      + 'a single sample can reverse.',
    'This tests the CONFIRMATION FILTER, not the value of knowing which group a stock is in. Group membership, leadership and '
      + 'laggard identification are descriptive and untouched by this result.',
  ],
  script: 'scripts/group-lead-lag.js',
});

export const GROUP_LEAD_LAG_STUDY = Object.freeze({
  status: 'NOT YET MEASURED',
  claim: 'Livermore: leading groups top and roll over three to six months before the overall market. He used this to '
    + 'call 1907 and 1929, and the book applies it to the 1999 leaders (Amazon, Yahoo, AOL, Lucent, Cisco, Sun, Microsoft).',
  his_own_counterexample: 'In 1929 copper and motors topped, he shorted the WHOLE market on that basis and "lost his '
    + 'shirt" — he had to wait about six months for utilities to confirm. So his own rule became: act on the group you '
    + 'can see, do NOT generalise to the market until a second group confirms.',
  why_it_is_hard: 'The scanner gives point-in-time performance only, not history, so a lead-lag test needs a stored '
    + 'panel of group series. TradingView serves ~300 bars per symbol, which is enough for a short-window test and not '
    + 'for a 3-6 month lead claim across cycles.',
  until_then: 'Treat group context as CONTEXT — the same standing as short_interest. It is not evidence the trade is '
    + 'better, and this repo has already had two alignment claims die on measurement.',
  script: 'scripts/group-lead-lag.js',
});
