/**
 * Repair the ta_validation fields in a report produced before 2026-07-28.
 *
 * Runs before that date emitted `ta_validation.ta_action`, `ta_urgency`,
 * `ta_conviction` and `ta_side` as null on every row — the schema documented
 * them and validateTa never returned them. Anything written against such a
 * report renders "TA said: None (None)" for the whole portfolio, and its own
 * tests pass.
 *
 * Those four are recoverable WITHOUT a re-run, because the same run already
 * stored the source values in `ta_suggestion` on the same row. This copies
 * them across.
 *
 * WHAT THIS CANNOT REPAIR — and does not pretend to:
 *   divergence.count / indicators_agreeing   read the wrong module keys
 *   elliott.valid_counts                     read the wrong module key
 * Those were computed wrongly from the bars and the bars are not in the file.
 * They stay as they are and the output records that they are untrustworthy.
 *
 * Writes a NEW file rather than editing in place — a run's report is a record
 * of what that run produced, and silently rewriting it would hide the defect
 * instead of correcting it.
 *
 *   node scripts/backfill-report.js reports/sunday-review-2026-07-28.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/backfill-report.js <report.json>');
  process.exit(1);
}

const rep = JSON.parse(readFileSync(src, 'utf8'));
let patched = 0, already = 0, unpatchable = 0;

for (const t of rep.tickers || []) {
  const v = t.ta_validation;
  const s = t.ta_suggestion;
  if (!v) continue;
  if (v.ta_action != null) { already++; continue; }
  if (!s) { unpatchable++; continue; }
  v.ta_side = v.ta_side ?? s.side ?? t.side ?? null;
  v.ta_action = s.action ?? null;
  v.ta_urgency = s.urgency ?? null;
  v.ta_conviction = s.conviction ?? null;
  patched++;
}

rep.backfilled = {
  from: src,
  fields: ['ta_validation.ta_side', 'ta_validation.ta_action', 'ta_validation.ta_urgency', 'ta_validation.ta_conviction'],
  source: 'ta_suggestion on the same row — the values that run already had',
  rows_patched: patched,
  rows_already_populated: already,
  rows_without_a_ta_suggestion: unpatchable,
  still_wrong: {
    'assessment.divergence.count': 'computed from a key surveyDivergences does not return; 0 on every row',
    'assessment.divergence.indicators_agreeing': 'same; null on every row',
    'assessment.elliott.valid_counts': 'computed from a key surveyCounts does not return; 0 on every row',
    note: 'These needed the bars, which this file does not carry. Do NOT filter on them. '
      + 'Re-run the review for correct values — read assessment.divergence.agreement, whose prose was right all along.',
  },
};

const out = src.replace(/\.json$/, '.backfilled.json');
writeFileSync(out, JSON.stringify(rep, null, 2), 'utf8');
console.log(`${out}`);
console.log(`  patched ${patched} rows, ${already} already populated, ${unpatchable} without a ta_suggestion`);
console.log('  divergence.count, divergence.indicators_agreeing and elliott.valid_counts remain WRONG — see `backfilled.still_wrong`.');
