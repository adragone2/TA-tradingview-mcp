/**
 * rules.json resolution and bootstrap.
 *
 * The setup flow most people follow never creates rules.json, which used to
 * make morning_brief / session_save / `tv brief` fail on first run. Resolution
 * is now non-fatal: callers get a usable default and a clear pointer to
 * `tv rules init` instead of an exception.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");

export const PROJECT_RULES = join(PROJECT_ROOT, "rules.json");
export const HOME_RULES = join(homedir(), ".tradingview-mcp", "rules.json");
export const EXAMPLE_RULES = join(PROJECT_ROOT, "rules.example.json");

/**
 * Search order for an existing rules.json.
 * `roots` exists so tests can point resolution at a temp directory instead of
 * having to move the developer's real rules.json out of the way.
 */
export function rulesSearchPaths(explicit, roots = [PROJECT_RULES, HOME_RULES]) {
  return [explicit, ...roots].filter(Boolean);
}

/**
 * Fallback used when no rules.json exists. Deliberately conservative — it
 * describes trend/momentum alignment in general terms rather than inventing
 * thresholds the user never chose.
 */
export const DEFAULT_RULES = {
  watchlist: [],
  default_timeframe: "240",
  bias_criteria: {
    bullish: [
      "Price is above its key moving averages and they are stacked upward",
      "Momentum indicators are rising and not yet at an extreme",
    ],
    bearish: [
      "Price is below its key moving averages and they are stacked downward",
      "Momentum indicators are falling and not yet at an extreme",
    ],
    neutral: [
      "Price is oscillating around its moving averages with no clear stack",
      "Momentum is mid-range and flat",
    ],
  },
  risk_rules: [],
  /**
   * Sizing inputs. `account_size` is NULL on purpose and is never defaulted to a
   * number: position_size_constrained would otherwise return a share count derived
   * from a figure nobody supplied, and a plausible-looking size is worse than a
   * refusal. During a live DLO analysis the account size was simply invented
   * ($100,000, Shannon's textbook figure) because there was nowhere to read it.
   */
  account: {
    account_size: null,
    risk_percent: 1,
    max_position_pct: 20,
    max_adv_pct: 2,
  },
  notes: null,
};

/**
 * The configured account size, or null.
 *
 * Null means "not configured" and callers must say so rather than substitute a
 * number. Accepts it at the top level too, because that is where a user is likely
 * to put it by hand.
 */
export function accountSettings(explicitPath, { roots } = {}) {
  const { rules, path, source } = resolveRules(explicitPath, { roots });
  const a = rules?.account || {};
  const size = Number.isFinite(Number(a.account_size)) && Number(a.account_size) > 0
    ? Number(a.account_size)
    : (Number.isFinite(Number(rules?.account_size)) && Number(rules?.account_size) > 0
      ? Number(rules.account_size)
      : null);
  return {
    account_size: size,
    risk_percent: Number.isFinite(Number(a.risk_percent)) ? Number(a.risk_percent) : null,
    max_position_pct: Number.isFinite(Number(a.max_position_pct)) ? Number(a.max_position_pct) : null,
    max_adv_pct: Number.isFinite(Number(a.max_adv_pct)) ? Number(a.max_adv_pct) : null,
    rules_path: path,
    source,
  };
}

/**
 * Resolve rules for a run. Never throws for a missing file.
 * Returns { rules, path, source, using_defaults, warning? }
 *   source: 'file' | 'defaults'
 * Throws only when a file exists but is unparseable — that is a real error
 * the user needs to fix, not something to silently paper over.
 */
export function resolveRules(explicitPath, { roots } = {}) {
  // An explicit path is authoritative: never silently fall through to another
  // rules.json, or the user ends up scanning a watchlist they didn't ask for.
  if (explicitPath && !existsSync(explicitPath)) {
    throw new Error(
      `No rules file at ${explicitPath}. Run "tv rules init" to create one, or omit --rules to use the default location.`,
    );
  }

  const candidates = rulesSearchPaths(explicitPath, roots);

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(
        `rules.json at ${p} is not valid JSON: ${e.message}. Fix the file, or delete it and run "tv rules init" for a fresh copy.`,
      );
    }
    return { rules: parsed, path: p, source: "file", using_defaults: false };
  }

  return {
    rules: { ...DEFAULT_RULES },
    path: null,
    source: "defaults",
    using_defaults: true,
    warning:
      'No rules.json found — using built-in defaults and your live TradingView watchlist. Run "tv rules init" to create one you can edit.',
    searched: candidates,
  };
}

/**
 * Create rules.json from rules.example.json.
 * Refuses to clobber an existing file unless force is set.
 */
export function initRules({ path, force = false } = {}) {
  const target = path || PROJECT_RULES;

  if (existsSync(target) && !force) {
    return {
      success: true,
      created: false,
      path: target,
      note: "rules.json already exists — left untouched. Pass force to overwrite.",
    };
  }

  if (!existsSync(EXAMPLE_RULES)) {
    throw new Error(
      `Template not found at ${EXAMPLE_RULES}. Reinstall or restore rules.example.json from the repo.`,
    );
  }

  const template = readFileSync(EXAMPLE_RULES, "utf8");
  // Validate before writing so we never produce a broken rules.json.
  try {
    JSON.parse(template);
  } catch (e) {
    throw new Error(`rules.example.json is not valid JSON: ${e.message}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, template);

  return {
    success: true,
    created: true,
    path: target,
    overwrote: force && existsSync(target),
    next: `Open ${target} and set your watchlist, bias_criteria, and risk_rules.`,
  };
}

/** Where rules would be read from right now, without loading them. */
export function rulesStatus({ roots } = {}) {
  const searched = rulesSearchPaths(null, roots);
  const found = searched.find((p) => existsSync(p)) || null;
  return {
    success: true,
    found: !!found,
    path: found,
    searched,
    example: EXAMPLE_RULES,
    hint: found ? null : 'Run "tv rules init" to create rules.json.',
  };
}
