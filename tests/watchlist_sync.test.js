/**
 * Watchlist sync unit tests — no TradingView or TA connection needed.
 *
 * Covers the symbol-equivalence layer, which is where this can quietly go
 * wrong: a bad equivalent writes an unresolvable entry into a 300-symbol
 * watchlist, and a missed one duplicates a symbol, which makes TradingView
 * reject the entire write with 422.
 *
 * Run: node --test tests/watchlist_sync.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { equivalentFor, bare, DEFAULT_MAPPING, SYMBOL_ALIASES } from '../src/core/watchlist_sync.js';

describe('bare()', () => {
  it('strips the exchange prefix', () => {
    assert.equal(bare('NASDAQ:AMD'), 'AMD');
    assert.equal(bare('COINBASE:BTCUSD'), 'BTCUSD');
  });

  it('leaves an unprefixed ticker alone and upper-cases it', () => {
    assert.equal(bare('amd'), 'AMD');
  });

  it('handles empty input without throwing', () => {
    assert.equal(bare(null), '');
    assert.equal(bare(undefined), '');
  });
});

describe('equivalentFor — exchange suffixes', () => {
  it('maps German listings', () => {
    assert.equal(equivalentFor('RHM.DE'), 'XETR:RHM');
  });

  it('maps a range of venues', () => {
    assert.equal(equivalentFor('SHOP.TO'), 'TSX:SHOP');
    assert.equal(equivalentFor('7203.T'), 'TSE:7203');
    assert.equal(equivalentFor('BP.L'), 'LSE:BP');
    assert.equal(equivalentFor('BHP.AX'), 'ASX:BHP');
  });

  it('returns null for an unknown suffix rather than guessing an exchange', () => {
    // Guessing would point at a different listing of the same ticker.
    assert.equal(equivalentFor('FOO.ZZ'), null);
  });
});

describe('equivalentFor — crypto', () => {
  it('appends venue and quote currency', () => {
    assert.equal(equivalentFor('BTC', { crypto: true }), 'COINBASE:BTCUSD');
    assert.equal(equivalentFor('ETH', { crypto: true }), 'COINBASE:ETHUSD');
  });

  it('does not double up a quote currency that is already present', () => {
    assert.equal(equivalentFor('BTCUSD', { crypto: true }), 'COINBASE:BTCUSD');
    assert.equal(equivalentFor('SOLUSDT', { crypto: true }), 'COINBASE:SOLUSDT');
  });

  it('does NOT apply the crypto rule to equities', () => {
    // BTC in an equity section must not silently become a crypto pair.
    assert.equal(equivalentFor('BTC', { crypto: false }), null);
  });
});

describe('equivalentFor — aliases and passthrough', () => {
  it('applies built-in aliases', () => {
    assert.equal(equivalentFor('SPX'), 'SP:SPX');
    assert.equal(equivalentFor('VIX'), 'CBOE:VIX');
  });

  it('lets a caller override an alias', () => {
    assert.equal(equivalentFor('SPX', { aliases: { SPX: 'FOREXCOM:SPXUSD' } }), 'FOREXCOM:SPXUSD');
  });

  it('an alias beats the suffix rule', () => {
    assert.equal(equivalentFor('RHM.DE', { aliases: { 'RHM.DE': 'FWB:RHM' } }), 'FWB:RHM');
  });

  it('passes an already-qualified symbol straight through', () => {
    assert.equal(equivalentFor('NASDAQ:AMD'), 'NASDAQ:AMD');
    assert.equal(equivalentFor('COINBASE:BTCUSD', { crypto: true }), 'COINBASE:BTCUSD');
  });

  it('returns null for a plain US ticker so it goes to lookup', () => {
    // Assuming an exchange here would be wrong as often as right.
    assert.equal(equivalentFor('AMD'), null);
    assert.equal(equivalentFor('UNKNOWNXYZ'), null);
  });

  it('handles empty input', () => {
    assert.equal(equivalentFor(''), null);
    assert.equal(equivalentFor(null), null);
  });
});

describe('mapping table', () => {
  it('maps TA files to section keys, not full section names', () => {
    // Section names carry invisible characters; the map must use the stripped
    // key so it never has to reproduce them.
    for (const target of Object.values(DEFAULT_MAPPING)) {
      assert.ok(!/^WATCHLIST\s*-/i.test(target), `${target} should be the key only`);
      assert.equal(target, target.toUpperCase());
    }
  });

  it('does not map any PORTFOLIO section', () => {
    // Portfolio sections reflect holdings, not watchlist files.
    for (const target of Object.values(DEFAULT_MAPPING)) {
      assert.ok(!/PORTFOLIO/i.test(target));
    }
  });

  it('aliases are all fully qualified', () => {
    for (const [k, v] of Object.entries(SYMBOL_ALIASES)) {
      assert.ok(v.includes(':'), `${k} -> ${v} must include an exchange`);
    }
  });
});
