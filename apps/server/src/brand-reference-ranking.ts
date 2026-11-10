import type { BrandCandidateScore } from './image-brand-inspection.js';

export const BRAND_REFERENCE_MIN_SUPPORT = 3;
export const BRAND_REFERENCE_MIN_SCORE = 0.72;
export const BRAND_REFERENCE_MIN_MARGIN = 0.04;

/** Average up to three closest reference photos for each brand. */
export function rankBrandReferences(matches: BrandCandidateScore[]): BrandCandidateScore[] {
  const byBrand = new Map<string, number[]>();
  for (const { brand, score } of matches) {
    if (!Number.isFinite(score)) continue;
    const values = byBrand.get(brand) ?? [];
    values.push(score);
    byBrand.set(brand, values);
  }
  return [...byBrand].map(([brand, values]) => {
    const top = values.sort((a, b) => b - a).slice(0, 3);
    return { brand, score: top.reduce((sum, value) => sum + value, 0) / top.length, supportCount: values.length };
  }).sort((a, b) => b.score - a.score || a.brand.localeCompare(b.brand, 'es'));
}

/** A reference vote is usable only with multiple varied examples and a clear lead. */
export function confidentReferenceBrand(matches: BrandCandidateScore[]) {
  const [top, runnerUp] = matches;
  if (!top || (top.supportCount ?? 0) < BRAND_REFERENCE_MIN_SUPPORT || top.score < BRAND_REFERENCE_MIN_SCORE) return null;
  if (runnerUp && top.score - runnerUp.score < BRAND_REFERENCE_MIN_MARGIN) return null;
  return top.brand;
}
