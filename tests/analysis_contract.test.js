import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SECTIONS, REQUIRED_KEYS, scoreAnalysis } from '../src/core/analysis_contract.js';

/**
 * The owner's objection, which this exists to answer: "manual step means I need to
 * ask you to perform it, and so if I forget it is equivalent to not having the
 * tool." Every gap in the first live analysis was caught by the owner, not by the
 * toolchain. Scoring against a contract is what makes an omission loud.
 */
describe('the contract itself', () => {
  test('the sections that were actually missed in the wild are REQUIRED', () => {
    for (const k of ['patterns', 'entry_hypothesis', 'drawings']) {
      const s = SECTIONS.find((x) => x.key === k);
      assert.ok(s, `${k} is not in the contract at all`);
      assert.equal(s.required, true, `${k} was missed in a live run — it must be required`);
    }
  });

  test('every section names a tool and a reason it matters', () => {
    for (const s of SECTIONS) {
      assert.ok(s.tool, `${s.key} names no tool`);
      assert.ok(s.why && s.why.length > 20, `${s.key} does not say why it matters`);
    }
  });

  test('required keys are derived from the sections, not a second list to drift', () => {
    assert.deepEqual(REQUIRED_KEYS, SECTIONS.filter((s) => s.required).map((s) => s.key));
  });
});

describe('scoring an analysis', () => {
  const allRan = () => Object.fromEntries(SECTIONS.map((s) => [s.key, { ok: true }]));

  test('everything run scores complete', () => {
    const r = scoreAnalysis(allRan());
    assert.equal(r.complete, true);
    assert.equal(r.missing.length, 0);
    assert.deepEqual(r.not_applicable, []);
    assert.match(r.summary, /All \d+ applicable required sections ran/);
  });

  test('NOT APPLICABLE is neither a pass nor a failure', () => {
    /**
     * `horizon` is required and is measured in TRADING DAYS, so on a 5-minute chart
     * it does not describe the position either way. Scoring that as a failure made
     * every intraday analysis report 11/12 INCOMPLETE — and a score that cries wolf
     * on correct behaviour is a score nobody reads, which is the one thing this
     * mechanism cannot afford: it exists so a genuinely skipped step is impossible
     * to miss.
     *
     * So it leaves the denominator rather than counting as done, and it is always
     * listed with its reason.
     */
    const results = allRan();
    results.horizon = { ok: false, not_applicable: true, reason: 'measured in trading days; these are 5-minute bars' };
    const r = scoreAnalysis(results);
    assert.equal(r.complete, true, 'an inapplicable section must not make the analysis incomplete');
    assert.equal(r.missing.length, 0);
    assert.deepEqual(r.not_applicable.map((n) => n.section), ['horizon']);
    assert.equal(r.required_applicable, r.required_total - 1, 'it leaves the denominator');
    assert.equal(r.required_done, r.required_total - 1, 'and is not counted as done either');
    assert.match(r.summary, /do not apply here: horizon/);
  });

  test('a skipped section is still a failure — only not_applicable is exempt', () => {
    // Otherwise any caller could silence a required step by flagging it skipped.
    const results = allRan();
    results.horizon = { ok: false, skipped: true, reason: 'could not be bothered' };
    const r = scoreAnalysis(results);
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing.map((m) => m.section), ['horizon']);
  });

  test('a section NOT MENTIONED AT ALL is the case that used to be invisible', () => {
    /**
     * The important one. An omitted section is not an empty result — it is a step
     * that never happened, and before this it looked identical to "ran and found
     * nothing".
     */
    const results = allRan();
    delete results.patterns;
    const r = scoreAnalysis(results);
    assert.equal(r.complete, false);
    const m = r.missing.find((x) => x.section === 'patterns');
    assert.match(m.reason, /NOT RUN/);
    assert.match(m.why_it_matters, /missing entirely from the first live analysis/i);
  });

  test('a failed section is reported with its error, not as absent', () => {
    const results = { ...allRan(), levels: { ok: false, error: 'no bars came back' } };
    const r = scoreAnalysis(results);
    assert.match(r.missing.find((x) => x.section === 'levels').reason, /failed: no bars came back/);
  });

  test('a deliberately skipped section carries its reason', () => {
    const results = { ...allRan(), screens: { ok: false, skipped: true, reason: 'needs a scanner round trip' } };
    const r = scoreAnalysis(results);
    assert.match(r.missing.find((x) => x.section === 'screens').reason, /scanner round trip/);
  });

  test('missing ADVISORY sections do not make the analysis incomplete', () => {
    const results = allRan();
    delete results.vcp;
    delete results.divergence;
    const r = scoreAnalysis(results);
    assert.equal(r.complete, true, 'advisory gaps are not defects');
    assert.deepEqual(r.advisory_missing.map((x) => x.section).sort(), ['divergence', 'vcp']);
  });

  test('an incomplete run is told to say so at the top', () => {
    const r = scoreAnalysis({});
    assert.equal(r.complete, false);
    assert.equal(r.required_done, 0);
    assert.match(r.summary, /INCOMPLETE/);
    assert.match(r.instruction, /must say so rather than reading as though the section found nothing/);
  });

  test('the summary names WHICH sections are missing, not just a count', () => {
    const results = allRan();
    delete results.momentum;
    delete results.horizon;
    const r = scoreAnalysis(results);
    assert.match(r.summary, /momentum/);
    assert.match(r.summary, /horizon/);
  });
});
