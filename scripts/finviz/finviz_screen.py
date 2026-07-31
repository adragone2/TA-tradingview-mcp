"""
Finviz — the fields TradingView's scanner does not have.

Adapted from TA's `ta_core/screeners/screener_finviz.py`. What was KEPT is the
preset architecture; what was DROPPED matters more:

  - The fundamental presets (quality_growth, garp_strict, crash_resilient,
    growth_innovator) and their Piotroski / R&D-intensity post-filters. Those are
    the INVESTING layer's job and TA already runs them. A second copy here would
    be the cross-layer duplication this repo keeps paying for — and it would drift.
  - `ta_core.data.datastore`, so this has no TA dependency at all.

── What this is FOR ──

Not a replacement for the eight swing screens. TradingView's scanner is the coarse
filter and is better at price: 3,771 fields, index-member universes, one POST.
Finviz is here for exactly what it does NOT return, verified against the live
filter dictionary:

  Option/Short   'Optionable and shortable'. TradingView returns null for every
                 spelling. A bearish setup on a name you cannot borrow is not a
                 trade, which makes this a CONSTRAINT in the same family as the
                 liquidity filter and the concentration cap.
  Earnings Date  BMO/AMC granularity — 'Today Before Market Open', 'Tomorrow After
                 Market Close'. Our scanner has `earnings_release_next_date`, a
                 DATE. Whether the print lands before tomorrow's open or after it
                 decides whether the event sits inside an overnight hold.

── What this deliberately does NOT do ──

It does not screen on price above the 20/50/200 SMAs. Finviz offers those filters
and a popular workflow leans on them, but that clause already exists here as
`stage_plan`, forward-tested with no lookahead over 198 independent events: long
33.5% against a 36.4% direction-matched baseline. It describes a move that has
already happened. Encoding it as a screen would launder a refuted idea into a
new-looking tool.

── Rate discipline ──

finvizfinance scrapes finviz.com. Every mode below issues a small fixed number of
paginated queries and answers by SET MEMBERSHIP, never a request per ticker —
thirty candidates cost the same as one.

Usage:
    python scripts/finviz/finviz_screen.py --preset tradable --json out.json
    python scripts/finviz/finviz_screen.py --tickers AAPL,MSFT,NVDA
    python scripts/finviz/finviz_screen.py --list-presets
"""

import argparse
import json
import sys
from datetime import datetime, timezone

try:
    import pandas as pd
    from finvizfinance.screener.overview import Overview
    FINVIZ_AVAILABLE = True
except ImportError:
    FINVIZ_AVAILABLE = False


# =============================================================================
# THE TICKER COLUMN IS CORRUPTED, AND THE OBVIOUS REPAIR IS WRONG
# =============================================================================
#
# finvizfinance 1.3.0 builds each cell with `col.text`, which concatenates EVERY
# text node in the <td>. The ticker cell contains the symbol twice — once in a
# hidden node — so every ticker comes back with its first character duplicated.
# Measured against the live site 2026-07-30, 1854 of 1854 rows:
#
#     parsed   company                      real
#     AA       Agilent Technologies         A
#     AAA      Alcoa Corp                   AA
#     AAAL     American Airlines            AAL
#     AABBV    AbbVie                       ABBV
#
# It does not throw. It returns 1,854 confident, wrong rows, and a membership test
# against that set answers False for every real ticker.
#
# ── Why "strip the duplicated first character" is NOT the fix ──
#
# It is ambiguous, and it corrupts real symbols. In that same scan BBVA and TT both
# appear — genuinely doubled first letters — and stripping turns them into BVA and
# T, which are a different company and a different company. Worse, Alcoa (AA) parses
# to AAA, and AAA is itself a real ETF: the corrupted form of one security is the
# valid ticker of another. No batch-level statistic can catch that, because the
# ambiguity is per-ticker, not per-batch.
#
# ── The actual fix ──
#
# Read the ticker from the DOM, where it is unambiguous. The <td> carries
# `data-boxover-ticker` (present on 20/20 rows), with the `<a class="tab-link">`
# anchor and then the last text node as fallbacks. Verified: BBVA and TT survive
# intact, and every other column is untouched.


def clean_ticker(td):
    """The symbol as the DOM states it, never as the concatenated text implies."""
    t = td.get('data-boxover-ticker')
    if t and t.strip():
        return t.strip()
    a = td.find('a', class_='tab-link')
    if a and a.text.strip():
        return a.text.strip()
    parts = [s.strip() for s in td.stripped_strings if s.strip()]
    if parts:
        # The hidden duplicate leads, so the LAST node is the rendered symbol.
        return parts[-1]
    return td.text.strip()


if FINVIZ_AVAILABLE:
    from finvizfinance.screener.base import number_covert

    class FixedOverview(Overview):
        """
        `Overview` with the ticker read from the DOM.

        Subclassed rather than monkey-patched so the override is visible at the call
        site: anything constructing a plain `Overview()` gets the corrupted column,
        and that should be obvious in a diff.
        """

        def _get_table(self, rows, df, num_col_index, table_header, limit=-1):
            rows = rows[1:]
            if limit != -1:
                rows = rows[0:limit]
            frame = []
            for row in rows:
                cols = row.find_all('td')[1:]
                info = {}
                for i, col in enumerate(cols):
                    header = table_header[i]
                    if header == 'Ticker':
                        info[header] = clean_ticker(col)
                    elif i not in num_col_index:
                        info[header] = col.text
                    else:
                        info[header] = number_covert(col.text)
                frame.append(info)
            if len(df) == 0:
                return pd.DataFrame(frame)
            return pd.concat([df, pd.DataFrame(frame)], ignore_index=True)


# =============================================================================
# PRESETS
#
# Every filter string is a verified key/option from finvizfinance's own
# `constants.filter_dict`. An invented name does not error — it is ignored, and
# the screen silently returns a wider set than was asked for.
# =============================================================================

# The liquidity bar the presets share. Held separately so `enrich` can ask which
# bar a name actually missed, rather than reporting one reason for three filters.
LIQUID_ONLY = {'Average Volume': 'Over 1M', 'Price': 'Over $10'}

FILTER_PRESETS = {
    'tradable': {
        'name': 'Optionable AND shortable, liquid',
        'why': 'The tradability gate TradingView cannot answer. A bearish signal on a name '
               'you cannot borrow is not a trade; an options overlay on a name with no chain '
               'is not a plan.',
        'filters': {'Option/Short': 'Optionable and shortable', **LIQUID_ONLY},
    },
    'earnings_this_week': {
        'name': 'Reporting within the week',
        'why': "Feeds the earnings veto with what our scanner lacks: BMO/AMC timing. A date "
               "alone cannot say whether the print lands inside tonight's hold.",
        'filters': {'Earnings Date': 'This Week', **LIQUID_ONLY},
    },
    'heavily_shorted': {
        'name': 'Float short over 20%',
        'why': "A CROSS-CHECK on our FINRA series, not a signal. Quote short_interest's "
               '`driver` beside it — 93% of large days-to-cover moves were driven by average '
               'VOLUME, not by the short position.',
        'filters': {'Float Short': 'Over 20%', **LIQUID_ONLY},
    },
}


def run_screener(filters):
    """
    One screener query.

    Returns `(rows, note)`. `rows` is None when the query could not run — distinct
    from `[]`, which means it ran and matched nothing.
    """
    if not FINVIZ_AVAILABLE:
        return None, 'finvizfinance not installed — pip install finvizfinance'
    try:
        o = FixedOverview()
        o.set_filter(filters_dict=filters)
        df = o.screener_view(verbose=0)
        if df is None or df.empty:
            return [], 'query ran, matched nothing'
        return df.to_dict('records'), f'{len(df)} rows, ticker read from data-boxover-ticker'
    except Exception as e:
        return None, f'screener error: {e}'


def tickers_of(rows):
    return {str(r.get('Ticker', '')).upper() for r in rows if r.get('Ticker')}


def enrich(tickers):
    """
    Answer what TradingView cannot, for a list our screens produced.

    THREE queries total, whatever the batch size — set membership, never a request
    per ticker.

    The third query is the liquidity bar ALONE, so a negative can be attributed.
    Without it, a name below 1M average volume would be reported under a field
    called `optionable_and_shortable`, which tests one thing and would be answering
    another. Garmin surfaced exactly that: `false` on the combined filter while
    being perfectly shortable, because its average volume sits on the boundary.
    """
    want = {str(t).split(':')[-1].upper() for t in tickers}

    tradable_rows, tradable_note = run_screener(FILTER_PRESETS['tradable']['filters'])
    liquid_rows, liquid_note = run_screener(LIQUID_ONLY)
    earn_rows, earn_note = run_screener(FILTER_PRESETS['earnings_this_week']['filters'])

    tradable = tickers_of(tradable_rows) if tradable_rows is not None else None
    liquid = tickers_of(liquid_rows) if liquid_rows is not None else None
    reporting = tickers_of(earn_rows) if earn_rows is not None else None

    out = {}
    for t in sorted(want):
        if tradable is None or liquid is None:
            shortable, why = None, 'a query failed — unknown, NOT a negative'
        elif t in tradable:
            shortable, why = True, None
        elif t in liquid:
            shortable, why = False, 'liquid enough, so this is a genuine borrow/options gap'
        else:
            shortable, why = None, ('below this query\'s liquidity bar (avg vol > 1M, price > $10), '
                                    'so shortability was never tested — not a shortability fact')
        out[t] = {
            'optionable_and_shortable': shortable,
            'basis': why,
            'reports_this_week': (t in reporting) if reporting is not None else None,
        }

    return {
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'sizes': {
            'tradable': len(tradable) if tradable is not None else None,
            'liquid': len(liquid) if liquid is not None else None,
            'reporting_this_week': len(reporting) if reporting is not None else None,
        },
        'parse': {'tradable': tradable_note, 'liquid': liquid_note, 'earnings': earn_note},
        'note': 'True/False are answers. null is unknown — a failed query or a name never '
                'tested — and unknown is NOT a negative.',
        'tickers': out,
    }


def main():
    p = argparse.ArgumentParser(description='Finviz — the fields TradingView lacks')
    p.add_argument('--preset', '-p', default=None)
    p.add_argument('--tickers', '-t', default=None, help='Comma-separated tickers to enrich')
    p.add_argument('--json', '-j', default=None, help='Write JSON here (default: stdout)')
    p.add_argument('--list-presets', '-l', action='store_true')
    args = p.parse_args()

    if args.list_presets:
        for k, v in FILTER_PRESETS.items():
            print(f'\n  --preset {k}\n    {v["name"]}\n    {v["why"]}')
            for fk, fv in v['filters'].items():
                print(f'      - {fk}: {fv}')
        print()
        return 0

    if args.tickers:
        result = enrich([t.strip() for t in args.tickers.split(',') if t.strip()])
    elif args.preset:
        if args.preset not in FILTER_PRESETS:
            print(f'unknown preset: {args.preset}', file=sys.stderr)
            return 1
        preset = FILTER_PRESETS[args.preset]
        rows, note = run_screener(preset['filters'])
        if rows is None:
            print(json.dumps({'error': note, 'preset': args.preset}, indent=2))
            return 1
        result = {
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'preset': args.preset, 'name': preset['name'], 'why': preset['why'],
            'filters': preset['filters'], 'parse': note,
            'count': len(rows), 'tickers': sorted(tickers_of(rows)),
        }
    else:
        p.print_help()
        return 1

    text = json.dumps(result, indent=2)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'wrote {args.json}')
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
