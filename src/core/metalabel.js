/**
 * Meta-labelling: a second model that decides whether to ACT on a signal the
 * first model already produced.
 *
 * After Lopez de Prado (2018) ch. 3. The idea is to separate SIDE from SIZE.
 * The primary model calls the direction — that is what every detector in
 * src/core/ already does. The secondary model answers a narrower and much
 * more learnable question: given that a bull flag has fired, in this regime,
 * at this relative strength, at this distance from the moving average — is
 * this one of the ones that works?
 *
 * It is the best architectural fit for this repo of anything in the ML
 * literature, because we already have the primary model and we already have
 * the context features. Nothing here tries to predict price.
 *
 * ── Why a decision stump ensemble and not something bigger ──
 *
 * We have hundreds of events, not hundreds of thousands. A 2026 study found a
 * 4-layer CNN with 422k parameters beat models 10-25x larger because the
 * larger ones overfit ~500 samples. At our scale the honest choice is a model
 * whose capacity is visibly bounded, whose splits are readable, and which
 * cannot memorise the training set. Depth-1 trees on bootstrapped samples do
 * that, and every split can be printed and argued with.
 *
 * ── The rule this module enforces ──
 *
 * A meta-model is only worth having if it beats taking every primary signal.
 * That comparison is not optional and is computed on held-out folds, so it
 * cannot be the training set flattering itself. Lopez de Prado's own caveat
 * applies: meta-labelling needs a good primary model. Against a weak one it
 * can only reduce the downside.
 *
 * All pure. No chart access, no training loop that touches the network.
 */
import { purgedKFold } from './validation.js';
import { rng } from './synthetic.js';

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * A depth-1 decision tree: one feature, one threshold, one direction.
 *
 * Chosen to maximise information gain on the binary target. Readable by
 * construction — "take the trade when efficiency_ratio > 0.31" is a sentence a
 * person can disagree with.
 */
function bestStump(rows, featureNames, weights) {
  let best = null;
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  for (const f of featureNames) {
    const values = [...new Set(rows.map((r) => r.features[f]).filter(Number.isFinite))].sort((a, b) => a - b);
    if (values.length < 2) continue;
    // Candidate thresholds at midpoints, capped so wide feature sets stay cheap.
    const step = Math.max(1, Math.floor(values.length / 24));
    for (let i = step; i < values.length; i += step) {
      const thr = (values[i - 1] + values[i]) / 2;
      for (const dir of [1, -1]) {
        let tp = 0, fp = 0, tn = 0, fn = 0;
        for (let r = 0; r < rows.length; r++) {
          const v = rows[r].features[f];
          if (!Number.isFinite(v)) continue;
          const predict = dir > 0 ? v > thr : v <= thr;
          const actual = rows[r].label === 1;
          const w = weights[r];
          if (predict && actual) tp += w;
          else if (predict && !actual) fp += w;
          else if (!predict && !actual) tn += w;
          else fn += w;
        }
        const correct = tp + tn;
        const acc = correct / total;
        if (!best || acc > best.accuracy) best = { feature: f, threshold: thr, direction: dir, accuracy: acc, tp, fp, tn, fn };
      }
    }
  }
  return best;
}

function stumpPredict(stump, features) {
  const v = features[stump.feature];
  if (!Number.isFinite(v)) return 0;                 // abstain on missing data
  return (stump.direction > 0 ? v > stump.threshold : v <= stump.threshold) ? 1 : -1;
}

/**
 * Train a bagged ensemble of stumps.
 *
 * Bagging over a seeded PRNG so a model is reproducible — a meta-model whose
 * decisions move between runs cannot be reviewed, and reviewing it is most of
 * the point.
 */
export function trainMetaModel(rows, { features = null, trees = 25, seed = 7 } = {}) {
  const usable = rows.filter((r) => r && r.features && (r.label === 1 || r.label === 0));
  if (usable.length < 20) {
    return { trained: false, note: `Only ${usable.length} usable events. Below about 20 a meta-model memorises rather than learns.` };
  }
  const featureNames = features || [...new Set(usable.flatMap((r) => Object.keys(r.features)))];
  const r = rng(seed);
  const stumps = [];

  for (let t = 0; t < trees; t++) {
    // Bootstrap by weighting, so every row stays available to the split search.
    const weights = usable.map(() => (r() < 0.632 ? 1 : 0));
    if (weights.reduce((a, b) => a + b, 0) < 5) continue;
    const s = bestStump(usable, featureNames, weights);
    if (s) stumps.push(s);
  }

  if (!stumps.length) return { trained: false, note: 'No usable split was found in any feature.' };

  const positives = usable.filter((x) => x.label === 1).length;
  return {
    trained: true,
    stumps,
    trees: stumps.length,
    features: featureNames,
    training_events: usable.length,
    training_base_rate: round(positives / usable.length),
    rules: stumps.slice(0, 10).map((s) => `${s.feature} ${s.direction > 0 ? '>' : '<='} ${round(s.threshold, 4)}`),
    note: 'Depth-1 stumps, bagged. Every rule is printable and arguable — that is deliberate at this sample size.',
  };
}

/** Ensemble vote in [0,1]: the share of stumps saying "take it". */
export function metaPredict(model, features) {
  if (!model?.trained) return null;
  let yes = 0, voted = 0;
  for (const s of model.stumps) {
    const v = stumpPredict(s, features);
    if (v === 0) continue;
    voted++;
    if (v === 1) yes++;
  }
  return voted ? yes / voted : null;
}

/**
 * The evaluation that decides whether any of this was worth doing.
 *
 * Trains and tests across purged folds, then compares against the only
 * baseline that matters: taking EVERY primary signal. A meta-model that
 * improves precision while filtering out most of the winners has not helped,
 * so recall and the trade count are reported next to it.
 */
export function evaluateMetaModel(rows, {
  features = null, trees = 25, seed = 7, k = 5, threshold = 0.5, embargo_pct = 0.01, label_spans = null,
} = {}) {
  const usable = rows.filter((r) => r && r.features && (r.label === 1 || r.label === 0));
  if (usable.length < 40) {
    return { evaluated: false, note: `Only ${usable.length} usable events; ${40} is the floor for a ${k}-fold estimate to mean anything.` };
  }

  const spans = label_spans || usable.map((r, i) => [i, i]);
  const { folds, total_purged } = purgedKFold(usable.length, { k, label_spans: spans, embargo_pct });

  let tp = 0, fp = 0, fn = 0, tn = 0;
  let takenReturn = 0, allReturn = 0, taken = 0;

  for (const fold of folds) {
    if (fold.train.length < 20) continue;
    const model = trainMetaModel(fold.train.map((i) => usable[i]), { features, trees, seed });
    if (!model.trained) continue;

    for (const i of fold.test) {
      const row = usable[i];
      const p = metaPredict(model, row.features);
      const act = p != null && p >= threshold;
      const win = row.label === 1;

      if (act && win) tp++;
      else if (act && !win) fp++;
      else if (!act && win) fn++;
      else tn++;

      if (Number.isFinite(row.ret)) {
        allReturn += row.ret;
        if (act) { takenReturn += row.ret; taken++; }
      }
    }
  }

  const evaluated = tp + fp + fn + tn;
  if (!evaluated) return { evaluated: false, note: 'No fold produced a trained model with test rows.' };

  const metaPrecision = tp + fp ? tp / (tp + fp) : null;
  const metaRecall = tp + fn ? tp / (tp + fn) : null;
  const primaryPrecision = evaluated ? (tp + fn) / evaluated : null;   // taking everything
  const lift = metaPrecision != null && primaryPrecision ? metaPrecision - primaryPrecision : null;

  return {
    evaluated: true,
    events: evaluated,
    folds: folds.length,
    purged_rows: total_purged,
    confusion: { true_positive: tp, false_positive: fp, false_negative: fn, true_negative: tn },
    meta: {
      precision: round(metaPrecision),
      recall: round(metaRecall),
      signals_taken: tp + fp,
      share_of_signals_taken: round((tp + fp) / evaluated),
    },
    primary_baseline: {
      precision: round(primaryPrecision),
      signals_taken: evaluated,
      description: 'Take EVERY primary signal. This is the thing the meta-model has to beat.',
    },
    precision_lift: round(lift),
    ...(Number.isFinite(allReturn) && taken ? {
      returns: {
        mean_return_all_signals: round(allReturn / evaluated, 6),
        mean_return_taken: round(takenReturn / taken, 6),
        total_return_all: round(allReturn, 6),
        total_return_taken: round(takenReturn, 6),
        note: 'Total return matters as much as the mean. A filter that raises the average while skipping most of the '
          + 'winners can leave you with a better-looking statistic and less money.',
      },
    } : {}),
    verdict: lift == null ? 'could not compare'
      : lift > 0.05 ? `helps: precision ${round(primaryPrecision)} -> ${round(metaPrecision)} on held-out folds`
      : lift > 0 ? `marginal: +${round(lift)} precision, within noise at this sample size`
      : 'does NOT help — taking every primary signal did as well or better',
    method: 'Purged K-fold with embargo. Each fold trains on rows whose label windows do not overlap its test set, so the '
      + 'comparison is not the training set grading itself.',
    caveat: 'Meta-labelling needs a good primary model. Against a weak one it can only reduce the downside, and a '
      + 'precision lift over a primary that is barely better than chance is not worth acting on. Check the primary '
      + 'baseline precision before reading the lift.',
  };
}

/**
 * Assemble meta-labelling rows from a primary signal, triple-barrier labels
 * and a context feature builder.
 *
 * `featuresAt(index)` MUST use only bars up to and including `index`. There is
 * no way for this module to verify that, and a look-ahead feature would make
 * every number above meaningless while looking excellent.
 */
export function buildMetaRows(bars, events, labels, featuresAt) {
  if (typeof featuresAt !== 'function') throw new Error('featuresAt must be a function of the bar index.');
  if (events.length !== labels.length) {
    throw new Error(`events (${events.length}) and labels (${labels.length}) must correspond one to one.`);
  }
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const l = labels[i];
    if (l.label == null) continue;
    const index = typeof events[i] === 'number' ? events[i] : events[i].index;
    // Meta-labelling is binary: did the primary signal WORK. A timed-out trade
    // did not work, so it joins the losses rather than being dropped — dropping
    // it would train the model only on events that resolved decisively.
    rows.push({
      index,
      label: l.label === 1 ? 1 : 0,
      ret: Number.isFinite(l.unrealized_return_pct) ? l.unrealized_return_pct / 100
        : (l.label === 1 ? 1 : -1) * 0.01,
      features: featuresAt(index),
      exit_index: l.exit_index ?? index,
    });
  }
  return {
    rows,
    spans: rows.map((r) => [r.index, r.exit_index]),
    note: 'Label 1 means the primary signal reached its profit target first. Timed-out trades count as 0, not as missing — '
      + 'training only on decisive outcomes would teach the model a world where trades always resolve.',
    contract: 'featuresAt(index) must use only bars up to and including index. This is not checked and cannot be.',
  };
}
