import { describe, expect, it } from 'vitest';
import { aggregateSneakerBrands } from './sneaker-model.js';

describe('sneaker classifier brand mapping', () => {
  it('sums models by brand and keeps Jordan separate from Nike', () => {
    expect(aggregateSneakerBrands([
      { label: 'nike_air_jordan_1_high', score: 0.3 },
      { label: 'nike_air_jordan_4', score: 0.2 },
      { label: 'nike_air_max_90', score: 0.25 },
      { label: 'new_balance_550', score: 0.15 },
      { label: 'puma_suede_classic', score: 0.1 },
    ])).toEqual([{ brand: 'Jordan', score: 0.5 }, { brand: 'Nike', score: 0.25 }, { brand: 'New Balance', score: 0.15 }, { brand: 'Puma', score: 0.1 }]);
  });
  it('ignores unknown and invalid outputs', () => {
    expect(aggregateSneakerBrands([{ label: 'unknown_shoe', score: 0.9 }, { label: 'adidas_samba', score: NaN }])).toEqual([]);
  });
});
