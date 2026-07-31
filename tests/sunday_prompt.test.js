import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { marketCondition } from '../src/core/review_rollup.js';

/**
 * The Sunday review's PROMPT has to move with its schema, and nothing made it.
 *
 * `scripts/sunday-review.js` went to schema 2.0 — every ticker's analysis moved under
 * a single `analysis` key — while the scheduled prompt still told the agent to extract
 * `assessment.market_regime.regime`, `assessment.trade_plans` and `assessment.channels`.
 *
 * Those are the worst kind of stale instruction, because **a 1.0 path read off a 2.0
 * report returns `undefined`. It does not throw.** So the regime distribution, the live
 * trade plans and the stable channels would simply be absent from the weekly summary,
 * with no error, no empty-section note, and nothing in the run to suggest that three
 * whole sections had been dropped. The same failure shape as `--holdings` being opt-in:
 * a silently shorter answer that reads as a complete one.
 *
 * Every regex below is a path or a term that was verified to resolve on the real
 * ~6MB report (reports/sunday-review-2026-07-30.json, 62 requested / 59 analysed /
 * 3 failed / 25 excluded) before it was written into the prompt.
 */
const src = (f) => readFileSync(`${process.cwd()}/${f}`, 'utf8').replace(/\r\n/g, '\n');
const PROMPT = 'skills/sunday-review/scheduled-task-prompt.md';
const SKILL = 'skills/sunday-review/SKILL.md';
const ROUTINES = 'docs/routines.md';

/**
 * A 1.0 path is `assessment.<field>` with nothing in front of it. The trailing
 * character class matters: without it, an ordinary sentence ending in "...the full
 * assessment." matches and the test cries wolf.
 */
const BARE_ASSESSMENT = /(?<!analysis\.)\bassessment\.[a-z_]/g;
/** `--holdings` but not `--no-holdings` — the latter is the current, correct flag. */
const OPT_IN_HOLDINGS = /--holdings\b/;

const lines = (f) => src(f).split('\n');
const linesMatching = (f, re) => lines(f)
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => re.test(l));

describe('the scheduled prompt extracts 2.0 paths, not 1.0 ones', () => {
  test('no bare `assessment.` path survives anywhere in the prompt', () => {
    const hits = [...src(PROMPT).matchAll(BARE_ASSESSMENT)]
      .map((m) => src(PROMPT).slice(Math.max(0, m.index - 70), m.index + 40).replace(/\n/g, ' '));
    assert.deepStrictEqual(hits, [],
      'a bare assessment.* path extracts undefined from a 2.0 report and the section '
      + 'vanishes from the summary without an error');
  });

  test('and no `our_view` — it is `analysis.verdict` now', () => {
    /**
     * The prompt deliberately carries NO trace of the old name. An agent reading a 2.0
     * report never needs it; it needs to know where the value is now. The full migration
     * table, old names and all, lives in docs/sunday-review-schema.md and in the skill,
     * both of which the prompt tells it to read in STEP 1.
     */
    assert.ok(!/our_view/.test(src(PROMPT)),
      'our_view was renamed to analysis.verdict; reading the old key returns undefined');
    assert.match(src(PROMPT), /analysis\.verdict/);
  });

  test('the three specific paths that were stale are now under `analysis.`', () => {
    // The exact trio from the 1.0 prompt, each verified present on all 59 analysed
    // rows of the real report.
    for (const p of [
      'analysis.assessment.market_regime.regime',
      'analysis.assessment.trade_plans',
      'analysis.assessment.channels',
    ]) assert.ok(src(PROMPT).includes(p), `the prompt must name ${p}`);
  });

  test('it tells the agent the paths moved, and to check schema_version', () => {
    // Knowing WHY beats knowing the list: the next schema bump should be caught by a
    // reader who has been told the shape can move, not only by this test.
    assert.match(src(PROMPT), /SCHEMA 2\.0/);
    assert.match(src(PROMPT), /schema_version/);
    assert.match(src(PROMPT), /undefined/, 'and that a stale path returns undefined rather than throwing');
  });
});

describe('the prompt reports what 2.0 added', () => {
  test('EXCLUDED is extracted and stated separately from FAILED', () => {
    /**
     * `counts.excluded` was 25 on the real report and every one of them was crypto —
     * TA's book on the investing layer, and unchartable here besides ("BTC-USD"
     * resolves to the spread CRYPTOCAP:BTC-BATS:USD). A failed ticker was attempted
     * and could not be read; an excluded one was never charted here at all. Collapsing
     * them makes a scope boundary read as breakage.
     */
    const p = src(PROMPT);
    assert.match(p, /excluded_from_review/);
    assert.match(p, /counts[\s\S]{0,120}excluded/, 'counts.excluded must be in the extraction list');
    assert.match(p, /EXCLUDED IS NOT FAILED|NOT failed/i);
  });

  test('holdings are described as the DEFAULT, and --no-holdings as the opt-out', () => {
    /**
     * The whole reason P0.1 exists beside the holdings fix: a prompt that still says
     * "~60 tickers TA wants action on" describes a review that skipped 35 positions.
     */
    const p = src(PROMPT);
    assert.match(p, /--no-holdings/);
    assert.match(p, /BY DEFAULT/);
    assert.ok(!/^\s*(Run|Add).*--holdings\b(?!-)/m.test(p),
      'the prompt must never instruct the run to pass --holdings');
  });

  test('completeness is read at both levels, with NOT APPLICABLE excused', () => {
    /**
     * `completeness_summary` came back as `{complete: 59}` — the `incomplete` key is
     * ABSENT when it is zero, because the script builds it with a reduce. A prompt that
     * prints it raw reports "incomplete: undefined".
     */
    const p = src(PROMPT);
    assert.match(p, /completeness_summary/);
    assert.match(p, /\?\? 0/, 'the absent-when-zero incomplete key needs the ?? 0');
    assert.match(p, /analysis\.completeness\.summary/);
    assert.match(p, /not_applicable/);
    assert.match(p, /neither a pass nor a failure/i);
  });

  test('portfolio heat is read once, as the whole book', () => {
    // Identical on all 59 rows: heat is a cross-position quantity, sized against TA's
    // own equity ($1.58M), NOT the $20,000 trading account in rules.json.
    const p = src(PROMPT);
    assert.match(p, /analysis\.context\.portfolio_heat/);
    assert.match(p, /ONCE/);
    assert.match(p, /equity/i);
  });

  test('the runtime reflects the whole book', () => {
    assert.ok(!/7-12 minutes|7–12 minutes/.test(src(PROMPT)),
      'the actionable-only runtime is wrong now that holdings are in');
    assert.match(src(PROMPT), /15-20 minutes|15–20 minutes/);
  });
});

describe('the skill doc matches the 2.0 contract', () => {
  test('`our_view` appears only as a migration note, never as a live key', () => {
    /**
     * The skill KEEPS the old names, unlike the prompt — it carries the migration table
     * a human reads when TA's importer breaks. So the assertion is not "absent" but
     * "never on its own": every mention has to sit beside `verdict`, which is where the
     * value actually is. A bare "read `our_view`" instruction cannot pass that.
     */
    const stray = linesMatching(SKILL, /our_view/).filter(([, l]) => !/verdict/.test(l));
    assert.deepStrictEqual(stray, [],
      'every our_view mention must name analysis.verdict beside it');
    assert.match(src(SKILL), /`ticker\.our_view`/, 'and the migration table must still show the old name');
  });

  test('`--holdings` is documented as an opt-OUT, and only recalled as history', () => {
    /**
     * `--holdings` was opt-in and the scheduled task never passed it: TA held 73
     * positions, the actionable list was 53, and 35 holdings were never queued. The
     * owner's rule — "The sunday routine analyzes all TA tickers period. no exclusions."
     * The flag row in the table must therefore be --no-holdings.
     */
    assert.ok(!/^\|\s*`--holdings`/m.test(src(SKILL)),
      'the flag table must document --no-holdings, not an opt-in --holdings');
    assert.match(src(SKILL), /^\|\s*`--no-holdings`/m);
    const prescriptive = linesMatching(SKILL, OPT_IN_HOLDINGS)
      .filter(([, l]) => !/was opt-in/.test(l));
    assert.deepStrictEqual(prescriptive, [],
      '--holdings may only appear in the sentence recording that it USED to be opt-in');
  });

  test('the per-ticker layout is the 2.0 one', () => {
    const s = src(SKILL);
    for (const k of ['analysis.assessment', 'analysis.verdict', 'analysis.drawings']) {
      assert.ok(s.includes(k), `the skill must name ${k}`);
    }
    // ta_validation is the one thing NOT under analysis — analyzeTicker says what the
    // chart shows, validateTa says whether that supports what TA wants done.
    assert.match(s, /`ta_suggestion` and `ta_validation` stay at the ticker top level/);
    assert.match(s, /schema v2\.0|schema 2\.0/i);
  });

  test('crypto exclusion carries its reason, not just its existence', () => {
    // BTC-USD does not fail on the chart. It lies — TradingView reads the hyphen as a
    // SPREAD operator. Documented at the decision in src/core/ta_symbols.js.
    const s = src(SKILL);
    assert.match(s, /CRYPTOCAP:BTC-BATS:USD/);
    assert.match(s, /ta_symbols\.js/);
    assert.match(s, /EXCLUDED is not FAILED/i);
  });
});

describe('the routines entry describes the run that actually happens', () => {
  test('the Sunday section is the whole book at the real runtime', () => {
    const doc = src(ROUTINES);
    const sunday = doc.slice(doc.indexOf('## Sunday routine'), doc.indexOf('## Working a single name'));
    assert.ok(sunday.length > 200, 'the Sunday section must still be findable by that heading');
    assert.ok(!/7–12 minutes|7-12 minutes/.test(sunday), 'the actionable-only runtime is stale');
    assert.match(sunday, /15–20 minutes|15-20 minutes/);
    assert.match(sunday, /--no-holdings/);
    assert.match(sunday, /schema 2\.0/i);
    // TA imports this file, so a moved key needs a migration prompt to go with it.
    assert.match(sunday, /ta-importer-migration-2\.0\.md/);
    assert.ok(existsSync(`${process.cwd()}/docs/ta-importer-migration-2.0.md`),
      'the migration prompt the routine points at must exist');
  });
});

describe('the two copies of the prompt are in step', () => {
  /**
   * The prompt lives in two places: this repo, and `~/.claude/scheduled-tasks/` where
   * the scheduler actually reads it. Editing the version-controlled copy alone changes
   * nothing about what runs on Sunday — which is precisely how it stayed on 1.0 paths.
   *
   * The live copy is outside the repo and absent on any other machine, so this checks
   * it only where it exists. It is not a substitute for the assertions above; it is the
   * drift check the file's own header asks for ("they must be kept in step").
   */
  const LIVE = 'C:/Users/angel/.claude/scheduled-tasks/sunday-review/SKILL.md';
  const body = (s) => {
    const i = s.indexOf('Run the weekly Sunday review');
    return i < 0 ? null : s.slice(i).trim();
  };

  test('the live scheduled copy carries the same prompt body', { skip: !existsSync(LIVE) }, () => {
    const live = body(readFileSync(LIVE, 'utf8').replace(/\r\n/g, '\n'));
    assert.ok(live, 'the live copy must still contain the prompt body');
    assert.strictEqual(live, body(src(PROMPT)),
      'the live scheduled copy has drifted from the version-controlled one — '
      + 'the scheduler runs the live copy, so a repo-only edit changes nothing');
  });

  test('the live copy keeps a name/description frontmatter', { skip: !existsSync(LIVE) }, () => {
    const raw = readFileSync(LIVE, 'utf8').replace(/\r\n/g, '\n');
    assert.match(raw, /^---\nname: sunday-review\ndescription: .+\n---/,
      'the scheduler reads the frontmatter; losing it unregisters the task');
  });
});

describe('the SCRIPT reads 2.0 paths too — a source contract', () => {
  /**
   * The prompt was not the only thing left on 1.0 paths. `scripts/sunday-review.js`
   * builds the top-level `market_condition` block by reducing over the ticker rows,
   * and kept reading `t.assessment?.market_regime?...` after 2.0 moved every row's
   * analysis under `t.analysis`. Same mechanism as the prompt, one layer down: **a
   * dead optional-chain path yields `undefined`, not an error.**
   *
   * The measured output on reports/sunday-review-2026-07-30.json, 59 analysed rows:
   *
   *   {"regime_counts":{}, "choppy_share_pct":null, "median_efficiency":null,
   *    "random_walk_efficiency":null, "broad_chop":false, "note":null}
   *
   * against a truth of 50 choppy / 6 mixed / 3 trending — 84.7% choppy, median
   * efficiency 0.174 against the 0.183 random-walk baseline. `broad_chop: false` is
   * the worst part: the one field a reader would act on inverted itself silently,
   * reading as "the market is fine" when it meant "this block read nothing".
   *
   * So the guard is on the SIGNATURE rather than on the values: no 1.0-shaped read
   * of a ticker row may survive in that file, and the next key that moves fails a
   * test instead of emitting an empty object.
   */
  const SCRIPT = 'scripts/sunday-review.js';

  /**
   * `t` is the ticker ROW, whose analysis lives under `t.analysis` in 2.0. Deliberately
   * NOT a bare `\.assessment` — `r.assessment` is correct and appears twice, because `r`
   * is `analyzeTicker`'s own return, which does carry a top-level `assessment`. It is the
   * row that nests it, not the analysis.
   */
  const ROW_1_0_READ = /\bt\.assessment\?\./;
  const ROW_OUR_VIEW = /\bt\.our_view\b/;

  /**
   * Scan CODE, not prose. The first version of this guard failed on the comment that
   * documents the bug — the fix's own explanation names `t.assessment?.` in order to
   * say it must never come back, and a naive line scan cannot tell the two apart.
   * Recording the dead path beside the live one is the repo's habit and worth more
   * than the handful of characters a stricter regex would save.
   */
  const codeLines = (f) => lines(f)
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\/?\*)/.test(l));
  const codeHits = (re) => codeLines(SCRIPT)
    .filter(([, l]) => re.test(l))
    .map(([n, l]) => `${n}: ${l.trim()}`);

  test('no `t.assessment?.` read survives — that path is undefined on every 2.0 row', () => {
    assert.deepStrictEqual(codeHits(ROW_1_0_READ), [],
      'a 1.0 row path yields undefined rather than throwing, so the block it feeds '
      + 'emits an empty object instead of failing — use t.analysis.assessment');
  });

  test('and no `t.our_view` — it is `t.analysis.verdict` now', () => {
    assert.deepStrictEqual(codeHits(ROW_OUR_VIEW), [],
      'our_view was renamed to verdict and moved under analysis');
  });

  test('nor the same read through any OTHER row accessor', () => {
    /**
     * Two of the three vacuous reads were `t.assessment?.`; the third was
     * `ok[0]?.assessment?.market_regime?.random_walk_efficiency`, which a guard
     * written around `t.` alone would not have caught. So the rule is the shape,
     * not the variable: any `.assessment?.` that is not reached through `analysis`.
     *
     * `r.assessment` stays legal and appears twice (the !r.assessment guard and the
     * validateTa call) — `r` is analyzeTicker's own return, which DOES carry a
     * top-level assessment. It is the ticker row that nests it, not the analysis.
     */
    assert.deepStrictEqual(codeHits(/(?<!analysis\?)\.assessment\?\./), [],
      'only `analysis?.assessment?.` resolves on a 2.0 ticker row');
  });

  test('the market_condition block reads through `analysis`, and says why', () => {
    /**
     * UPDATED after the owner re-surfaced this defect from the 15:16 pre-fix
     * report (2026-07-30): the block is now EXTRACTED to
     * src/core/review_rollup.js so it can be tested by CALL, not just by
     * regex — a neutered condition passes every source contract (the P2.4
     * lesson). Here: the script must still USE it, and the 2.0 paths and the
     * why-comment must live with the function.
     */
    const s = src(SCRIPT);
    assert.ok(s.includes('market_condition: marketCondition(ok)'),
      'the script must delegate to the extracted, callable rollup');
    assert.match(s, /from '\.\.\/src\/core\/review_rollup\.js'/, 'and import it from the core module');
    const r = src('src/core/review_rollup.js');
    for (const p of [
      't.analysis?.assessment?.market_regime?.regime',
      't.analysis?.assessment?.market_regime?.efficiency',
      '?.analysis?.assessment?.market_regime?.random_walk_efficiency',
    ]) assert.ok(r.includes(p), `marketCondition must read ${p}`);
    assert.match(r, /undefined.?, not an error/,
      'the comment recording why this block was vacuous must stay with the function');
  });

  test('marketCondition POPULATES on 2.0 rows — by call, not by regex', () => {
    /**
     * The half no source contract can prove. Fixture rows shaped like the real
     * 2026-07-30 report: without the `analysis.` prefix the old code emitted
     * {regime_counts: {}, broad_chop: false} — a positive statement that the
     * market was fine, assembled out of nothing.
     */
    const row = (regime, efficiency) => ({
      analysis: { assessment: { market_regime: { regime, efficiency, random_walk_efficiency: 0.183 } } },
    });
    const mc = marketCondition([
      row('choppy', 0.15), row('choppy', 0.174), row('choppy', 0.2), row('trending', 0.5),
    ]);
    assert.deepEqual(mc.regime_counts, { choppy: 3, trending: 1 });
    assert.equal(mc.choppy_share_pct, 75);
    // floor(4/2) = index 2 of the sorted four: the block's median convention
    // takes the upper-middle on even counts.
    assert.equal(mc.median_efficiency, 0.2);
    assert.equal(mc.random_walk_efficiency, 0.183);
    assert.equal(mc.broad_chop, true, 'three choppy of four IS broad chop — false here was the whole defect');
    assert.match(mc.note, /below the 0\.3 efficiency gate/);
  });

  test('marketCondition on 1.0-shaped rows is EMPTY and honest, never a verdict', () => {
    // The regression the defect report feared: flat pre-2.0 rows must produce
    // nulls — not broad_chop: false read as "the market is fine".
    const mc = marketCondition([
      { assessment: { market_regime: { regime: 'choppy', efficiency: 0.1 } } },
      { assessment: { market_regime: { regime: 'choppy', efficiency: 0.2 } } },
    ]);
    assert.deepEqual(mc.regime_counts, {});
    assert.equal(mc.choppy_share_pct, null);
    assert.equal(mc.median_efficiency, null);
    assert.equal(mc.broad_chop, false);
    assert.equal(mc.note, null, 'no note may be manufactured from rows it could not read');
  });
});

describe('every path the prompt names resolves on a real report', () => {
  /**
   * The point of the whole task, asserted against real data rather than against the
   * schema doc — a doc can be wrong in exactly the same way the prompt was.
   *
   * `reports/` is gitignored (regenerated each run), so this runs only where a report
   * is present. Where it IS present it is the strongest check here: it lifts every
   * `analysis.*` path out of the prompt and resolves it on each analysed ticker.
   */
  const dir = `${process.cwd()}/reports`;
  const latest = () => {
    if (!existsSync(dir)) return null;
    const f = readdirSync(dir).filter((x) => /^sunday-review-\d{4}-\d\d-\d\d\.json$/.test(x)).sort().pop();
    return f ? `${dir}/${f}` : null;
  };
  const file = latest();

  test('the `analysis.*` paths named in the prompt are present on every analysed row',
    { skip: !file }, () => {
      const report = JSON.parse(readFileSync(file, 'utf8'));
      assert.strictEqual(report.schema_version, '2.0', 'this check only means anything against 2.0');
      const ok = report.tickers.filter((t) => t.status === 'ok');
      assert.ok(ok.length > 0, 'need at least one analysed ticker');

      // Whole dotted paths as written in the prompt, minus trailing punctuation and the
      // `.*` the prose uses for "and everything under it".
      const paths = [...new Set(
        (src(PROMPT).match(/\banalysis(?:\.[a-z_]+)+/g) || [])
          .map((p) => p.replace(/\.$/, ''))
          .filter((p) => p.split('.').length > 1),
      )];
      assert.ok(paths.length >= 8, `expected the prompt to name several paths, found ${paths.length}`);

      const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
      const broken = [];
      for (const p of paths) {
        // `undefined` is the bug: the key is not there at all. `null` is a legitimate
        // "measured, no value" and the schema promises the key regardless.
        const missing = ok.filter((t) => get(t, p) === undefined).length;
        if (missing) broken.push(`${p} missing on ${missing}/${ok.length}`);
      }
      assert.deepStrictEqual(broken, [],
        'a path in the prompt that does not resolve extracts undefined, silently');
    });

  test('a failed row still carries every top-level key, with analysis null',
    { skip: !file }, () => {
      // "failed" is unknown, not agreeing — and the prompt says to report it. It can
      // only do that if the row is still shaped like a row.
      const report = JSON.parse(readFileSync(file, 'utf8'));
      for (const t of report.tickers.filter((x) => x.status === 'failed')) {
        assert.strictEqual(t.analysis, null, `${t.ticker} should carry analysis: null`);
        assert.strictEqual(t.ta_validation, null, `${t.ticker} should carry ta_validation: null`);
        assert.ok(t.error, `${t.ticker} must say why it failed`);
      }
    });
});
