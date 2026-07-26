---
name: morning-note
description: Turn the morning brief into a written, shareable morning note rather than terminal JSON. Use when the user wants their session bias as prose they can read, save, or send — "write up my morning note", "draft today's note".
---

# Morning Note

Produces a written note from the technical scan. `morning_brief` gives structured data; this gives the deliverable.

## Step 1: Gather

1. Run `morning_brief` (or `catalyst-aware-brief` if event risk matters — prefer that for equity watchlists).
2. Run `session_get` to pull the previous session's note. What *changed* is usually the most valuable part of a morning note.

## Step 2: Format

If the `equity-research:morning-note` skill is available, invoke it and hand it the scan output — it owns the house format. Otherwise use this structure:

```markdown
# Morning Note — <date>

**Overall:** <one sentence: the session read>

## Changes since last session
- <what flipped bias, what broke a level, what is new>

## Tier A — worth attention
| Symbol | Bias | Key level | Catalyst | Watch |

## Tier B — needs confirmation
| Symbol | Bias | Key level | Catalyst | Watch |

## Tier C
<names only, one line>

## Risk notes
- <the applicable items from rules.risk_rules>

**Data:** <timeframes scanned, symbol count, anything unreliable>
```

## Step 3: Ground every claim

- Levels come from `drawn_levels`, `drawn_labels`, or `price_action` high/low. If nothing supports a level, write `n/a`.
- "Changes since last session" must be a real diff against `session_get`. If there is no saved prior session, say so — do not invent a comparison.
- Symbols with `error` or `warning` go in a "readings unavailable" line, not in a tier.

## Step 4: Save

Offer to save with `session_save` so tomorrow's note can diff against it. Save the written note, not the raw JSON.

If the user wants it as a file, write it to the repo or their chosen path as markdown. Ask before writing anywhere outside the working directory.

## Guardrails

- Write in the user's own terms. The bias criteria are theirs; the note applies them, it does not second-guess them.
- Analysis against stated criteria, not trade advice. No position sizing unless the user asked and supplied the inputs.
- Keep it short. A morning note that takes ten minutes to read does not get read.
