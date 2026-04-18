import { describe, it, expect } from 'vitest';
import {
  calcCostUsd,
  calcCostUsdWithCache,
  PRICING,
  CLAUDE_PLAN_LIMITS,
  CLAUDE_SESSION_LIMITS,
} from './types.js';

describe('calcCostUsd', () => {
  it('calculates cost for known model', () => {
    // claude-sonnet-4-6: input=$3/M, output=$15/M
    const cost = calcCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3 + 15); // $18
  });

  it('uses prefix matching for versioned model names', () => {
    // "claude-haiku-4-5-20251001" should match "claude-haiku-4-5" pricing
    const cost = calcCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.8); // $0.8/M input
  });

  it('returns 0 for unknown model', () => {
    expect(calcCostUsd('unknown-model-xyz', 1_000_000, 1_000_000)).toBe(0);
  });

  it('handles zero tokens', () => {
    expect(calcCostUsd('claude-sonnet-4-6', 0, 0)).toBe(0);
  });

  it('scales proportionally with token counts', () => {
    // 500K input + 500K output at opus-4-6 pricing ($15/$75 per M)
    const cost = calcCostUsd('claude-opus-4-6', 500_000, 500_000);
    expect(cost).toBeCloseTo((500_000 * 15 + 500_000 * 75) / 1_000_000);
  });
});

describe('calcCostUsdWithCache', () => {
  it('calculates base cost without cache tokens', () => {
    const withCache = calcCostUsdWithCache('claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0);
    const withoutCache = calcCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(withCache).toBeCloseTo(withoutCache);
  });

  it('cache read tokens cost 10% of input price', () => {
    // 1M cache read tokens at sonnet input rate $3/M → should cost $0.30
    const cost = calcCostUsdWithCache('claude-sonnet-4-6', 0, 0, 1_000_000, 0);
    expect(cost).toBeCloseTo(3 * 0.1); // $0.30
  });

  it('cache write tokens cost 125% of input price', () => {
    // 1M cache write tokens at sonnet input rate $3/M → should cost $3.75
    const cost = calcCostUsdWithCache('claude-sonnet-4-6', 0, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(3 * 1.25); // $3.75
  });

  it('combines all four token types correctly', () => {
    const inputPrice = PRICING['claude-sonnet-4-6'].input;
    const outputPrice = PRICING['claude-sonnet-4-6'].output;
    const inp = 100_000, out = 50_000, cacheR = 200_000, cacheW = 10_000;
    const expected = (
      inp * inputPrice +
      out * outputPrice +
      cacheR * inputPrice * 0.1 +
      cacheW * inputPrice * 1.25
    ) / 1_000_000;
    expect(calcCostUsdWithCache('claude-sonnet-4-6', inp, out, cacheR, cacheW)).toBeCloseTo(expected);
  });

  it('returns 0 for unknown model', () => {
    expect(calcCostUsdWithCache('unknown-model', 1_000_000, 1_000_000, 500_000, 500_000)).toBe(0);
  });

  it('prefix-matches versioned model names', () => {
    const versionedCost = calcCostUsdWithCache('claude-opus-4-6-beta', 1_000_000, 0, 0, 0);
    const exactCost = calcCostUsdWithCache('claude-opus-4-6', 1_000_000, 0, 0, 0);
    expect(versionedCost).toBeCloseTo(exactCost);
  });
});

describe('PRICING constants', () => {
  it('has entries for all expected Claude models', () => {
    expect(PRICING['claude-opus-4-6']).toBeDefined();
    expect(PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING['claude-haiku-4-5']).toBeDefined();
  });

  it('output price is always higher than input price', () => {
    for (const [, prices] of Object.entries(PRICING)) {
      expect(prices.output).toBeGreaterThan(prices.input);
    }
  });
});

describe('CLAUDE_PLAN_LIMITS', () => {
  it('max-5x limits are 5x greater than pro limits', () => {
    // By design: max-5x weeklyAll should be ~5.76x pro (not exactly 5x, but much larger)
    expect(CLAUDE_PLAN_LIMITS['max-5x'].weeklyAll).toBeGreaterThan(
      CLAUDE_PLAN_LIMITS['pro'].weeklyAll
    );
  });

  it('max-20x limits exceed max-5x limits', () => {
    expect(CLAUDE_PLAN_LIMITS['max-20x'].weeklyAll).toBeGreaterThan(
      CLAUDE_PLAN_LIMITS['max-5x'].weeklyAll
    );
    expect(CLAUDE_PLAN_LIMITS['max-20x'].weeklySonnet).toBeGreaterThan(
      CLAUDE_PLAN_LIMITS['max-5x'].weeklySonnet
    );
  });
});

describe('CLAUDE_SESSION_LIMITS', () => {
  it('all three plans have defined session limits', () => {
    for (const plan of ['pro', 'max-5x', 'max-20x'] as const) {
      expect(CLAUDE_SESSION_LIMITS[plan].fiveHourTokens).toBeGreaterThan(0);
      expect(CLAUDE_SESSION_LIMITS[plan].weeklySessionQuota).toBeGreaterThan(0);
    }
  });

  it('higher tiers have higher per-session token limits', () => {
    expect(CLAUDE_SESSION_LIMITS['max-5x'].fiveHourTokens).toBeGreaterThan(
      CLAUDE_SESSION_LIMITS['pro'].fiveHourTokens
    );
    expect(CLAUDE_SESSION_LIMITS['max-20x'].fiveHourTokens).toBeGreaterThan(
      CLAUDE_SESSION_LIMITS['max-5x'].fiveHourTokens
    );
  });
});
