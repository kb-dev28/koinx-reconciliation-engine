const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isTypeCompatible,
  withinQuantityTolerance,
  withinTimestampTolerance,
  normaliseAsset,
} = require('../services/matchingService');

describe('isTypeCompatible', () => {
  it('BUY vs BUY → true', () => {
    assert.equal(isTypeCompatible('BUY', 'BUY'), true);
  });

  it('SELL vs SELL → true', () => {
    assert.equal(isTypeCompatible('SELL', 'SELL'), true);
  });

  it('TRANSFER_OUT vs TRANSFER_IN → true', () => {
    assert.equal(isTypeCompatible('TRANSFER_OUT', 'TRANSFER_IN'), true);
  });

  it('TRANSFER_IN vs TRANSFER_OUT → true', () => {
    assert.equal(isTypeCompatible('TRANSFER_IN', 'TRANSFER_OUT'), true);
  });

  it('BUY vs SELL → false', () => {
    assert.equal(isTypeCompatible('BUY', 'SELL'), false);
  });

  it('null vs BUY → false', () => {
    assert.equal(isTypeCompatible(null, 'BUY'), false);
  });

  it('undefined vs undefined → false', () => {
    assert.equal(isTypeCompatible(undefined, undefined), false);
  });
});

describe('withinQuantityTolerance', () => {
  it('0.3 vs 0.3 at 0.01% → true (exact match)', () => {
    assert.equal(withinQuantityTolerance(0.3, 0.3, 0.01), true);
  });

  it('0.5 vs 0.5001 at 0.01% → false (exceeds tolerance)', () => {
    assert.equal(withinQuantityTolerance(0.5, 0.5001, 0.01), false);
  });

  it('0.5 vs 0.500001 at 0.01% → true (within tolerance)', () => {
    assert.equal(withinQuantityTolerance(0.5, 0.500001, 0.01), true);
  });

  it('null vs 0.5 → false', () => {
    assert.equal(withinQuantityTolerance(null, 0.5, 0.01), false);
  });

  it('NaN vs 0.5 → false', () => {
    assert.equal(withinQuantityTolerance(NaN, 0.5, 0.01), false);
  });
});

describe('withinTimestampTolerance', () => {
  const base = new Date('2024-03-01T09:00:00Z');

  it('same timestamp → true', () => {
    assert.equal(withinTimestampTolerance(base, base, 300), true);
  });

  it('30 seconds apart, tolerance 300 → true', () => {
    const other = new Date(base.getTime() + 30 * 1000);
    assert.equal(withinTimestampTolerance(base, other, 300), true);
  });

  it('400 seconds apart, tolerance 300 → false', () => {
    const other = new Date(base.getTime() + 400 * 1000);
    assert.equal(withinTimestampTolerance(base, other, 300), false);
  });

  it('null vs valid date → false', () => {
    assert.equal(withinTimestampTolerance(null, base, 300), false);
  });
});

describe('normaliseAsset', () => {
  it("'bitcoin' → 'BTC'", () => {
    assert.equal(normaliseAsset('bitcoin'), 'BTC');
  });

  it("'BTC' → 'BTC'", () => {
    assert.equal(normaliseAsset('BTC'), 'BTC');
  });

  it("'eth' → 'ETH'", () => {
    assert.equal(normaliseAsset('eth'), 'ETH');
  });

  it('null → null', () => {
    assert.equal(normaliseAsset(null), null);
  });

  it("'' → null", () => {
    assert.equal(normaliseAsset(''), null);
  });

  it("'  btc  ' → 'BTC' (trims whitespace)", () => {
    assert.equal(normaliseAsset('  btc  '), 'BTC');
  });
});

describe('ingestionService normalisation helpers', () => {
  it('are internal (not exported); covered indirectly via matchingService + integration', () => {
    const ingestion = require('../services/ingestionService');
    assert.equal(typeof ingestion.processCSV, 'function');
    assert.equal(ingestion.normaliseAsset, undefined);
  });
});
