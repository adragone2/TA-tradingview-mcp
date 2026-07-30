/**
 * Core indicator settings logic.
 */
import { evaluate } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * Apply input overrides to a study by input ID, then VERIFY they took.
 *
 * Two traps here, both found by watching a live chart report success while doing
 * nothing at all:
 *
 * 1. `getInputValues()` returns `[]` until the study has finished loading. The
 *    read-mutate-write pattern below then matches nothing and writes nothing, and
 *    the caller gets `success: true` with an empty `updated_inputs`. A freshly
 *    created study is ALWAYS in this state for a while, which is exactly when
 *    inputs get set. So wait for the inputs to exist.
 * 2. `setInputValues()` assigns by matching the element's `id`, so an element
 *    without one is skipped silently, and an element whose `value` is itself an
 *    object gets stored as that object — leaving `length` set to
 *    `{id:'length',value:200}` and the study quietly back on its default.
 *
 * So: wait, mutate by ID, write, read the property state back, and name anything
 * that did not take. A requested key that matches no input ID is a caller error
 * (usually a display name like "Simple Moving Average (50)" instead of `length`),
 * and it throws rather than passing silently.
 */
export async function applyInputs({ entity_id, overrides, attempts = 12, delayMs = 250 }) {
  const escapedId = entity_id.replace(/'/g, "\\'");
  const wanted = Object.keys(overrides);
  const script = `
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var cur = study.getInputValues();
      if (!cur || cur.length === 0) return { not_ready: true };
      var overrides = ${JSON.stringify(overrides)};
      var applied = {}; var knownIds = [];
      for (var i = 0; i < cur.length; i++) {
        knownIds.push(cur[i].id);
        if (Object.prototype.hasOwnProperty.call(overrides, cur[i].id)) {
          cur[i].value = overrides[cur[i].id];
          applied[cur[i].id] = overrides[cur[i].id];
        }
      }
      study.setInputValues(cur);
      // Read back from the property tree — the only authority on what stuck.
      var actual = {};
      try {
        var state = study.properties().inputs.state();
        var keys = ${JSON.stringify(wanted)};
        for (var k = 0; k < keys.length; k++) actual[keys[k]] = state[keys[k]];
      } catch (e) { actual = null; }
      return { applied: applied, known_ids: knownIds, actual: actual };
    })()
  `;

  let result = null;
  for (let i = 0; i < attempts; i += 1) {
    result = await evaluate(script);
    if (result && result.error) throw new Error(result.error);
    if (result && !result.not_ready) break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!result || result.not_ready) {
    throw new Error(
      `Study ${entity_id} never exposed its inputs (getInputValues() stayed empty after `
      + `${attempts} attempts). Nothing was changed.`,
    );
  }

  const unknown = wanted.filter((k) => !result.known_ids.includes(k));
  if (unknown.length === wanted.length) {
    throw new Error(
      `None of the requested inputs exist on this study: ${unknown.join(', ')}. `
      + `Its input IDs are: ${result.known_ids.join(', ')}. Note that a period is an INPUT `
      + `(e.g. { length: 200 }), not part of the study name.`,
    );
  }

  // Verify rather than trust: compare what came back against what was asked for.
  const notApplied = [];
  if (result.actual) {
    for (const k of Object.keys(result.applied)) {
      if (JSON.stringify(result.actual[k]) !== JSON.stringify(overrides[k])) {
        notApplied.push({ input: k, requested: overrides[k], actual: result.actual[k] });
      }
    }
  }

  return {
    entity_id,
    updated_inputs: result.applied,
    input_ids: result.known_ids,
    ...(result.actual ? { verified_values: result.actual } : {}),
    ...(unknown.length ? {
      unknown_inputs: unknown,
      unknown_note: `${unknown.join(', ')} do not exist on this study and were ignored.`,
    } : {}),
    ...(notApplied.length ? {
      not_applied: notApplied,
      not_applied_note: 'TradingView did not keep these values. They are reported rather than '
        + 'passed off as applied.',
    } : {}),
    inputs_verified: notApplied.length === 0,
  };
}

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const applied = await applyInputs({ entity_id, overrides: inputs });
  return { success: applied.inputs_verified, ...applied };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const escapedId = entity_id.replace(/'/g, "\\'");
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
