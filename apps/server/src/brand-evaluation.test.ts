import { describe, expect, it } from 'vitest';
import { BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND, evaluateBrandSuggestions } from './brand-evaluation.js';

describe('brand precision and coverage gate', () => {
  it('reports precision and coverage independently, including false positives and misses', () => {
    expect(evaluateBrandSuggestions([
      { predictedBrand: 'Nike', expectedBrand: 'Nike' },
      { predictedBrand: 'Nike', expectedBrand: 'Adidas' },
      { predictedBrand: null, expectedBrand: 'Adidas' },
    ])).toMatchObject({ evaluationCount: 3, predictionCount: 2, correctCount: 1, precision: 0.5, coverage: 2 / 3, autoEligibleBrands: [] });
  });

  it('only enables a brand after at least 20 reviewed suggestions and 95% precision', () => {
    const perfect = Array.from({ length: BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND }, () => ({ predictedBrand: 'New Balance', expectedBrand: 'New Balance' }));
    expect(evaluateBrandSuggestions(perfect).autoEligibleBrands).toEqual(['New Balance']);
    perfect[0] = { predictedBrand: 'New Balance', expectedBrand: 'Puma' };
    perfect[1] = { predictedBrand: 'New Balance', expectedBrand: 'Puma' };
    expect(evaluateBrandSuggestions(perfect).autoEligibleBrands).toEqual([]);
  });
});
