import { describe, expect, it } from 'vitest';
import { rankBrandReferences } from './brand-reference-ranking.js';

describe('brand reference ranking', () => {
  it('averages at most three references per brand and orders ties deterministically', () => {
    const rows = rankBrandReferences([
      { brand: 'Nike', score: 0.9 }, { brand: 'Nike', score: 0.6 },
      { brand: 'Nike', score: 0.3 }, { brand: 'Nike', score: 0 },
      { brand: 'Adidas', score: 0.6 },
    ]);
    expect(rows[0]?.brand).toBe('Adidas');
    expect(rows[1]?.brand).toBe('Nike');
    expect(rows[1]?.score).toBeCloseTo(0.6);
  });
});
