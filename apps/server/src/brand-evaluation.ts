import { normalizeBrandName } from './brand-candidates.js';
import { confidentReferenceBrand } from './brand-reference-ranking.js';
import type { BrandCandidateScore, ImageBrandInspection } from './image-brand-inspection.js';

export type BrandEvaluationSample = {
  predictedBrand: string | null;
  expectedBrand: string | null;
  sourcePredictions?: Record<string, string | null>;
};
export const BRAND_AUTO_PRECISION_THRESHOLD = 0.95;
export const BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND = 20;

export function brandSourcePredictions(candidates: BrandCandidateScore[], evidence: ImageBrandInspection['evidence']) {
  const top = candidates[0];
  const nonBrand = Math.max(evidence.unknownScore ?? 0, evidence.noShoeScore ?? 0, evidence.mixedBrandsScore ?? 0);
  return {
    'Florence + Qwen': evidence.visualBrand ?? null,
    'SigLIP · clases abiertas': top && top.score > nonBrand && top.score >= 0.12 ? top.brand : null,
    'SigLIP · referencias': confidentReferenceBrand(evidence.referenceMatches ?? []),
    'Detector de zapatillas': evidence.sneakerCandidates?.[0]?.brand ?? null,
  };
}

export function evaluateBrandSuggestions(samples: BrandEvaluationSample[]) {
  const summarize = (rows: Array<{ predictedBrand: string | null; expectedBrand: string | null }>) => {
    const selected = rows.filter((sample) => sample.predictedBrand !== null);
    const correctRows = selected.filter((sample) => sample.expectedBrand !== null
      && normalizeBrandName(sample.predictedBrand!) === normalizeBrandName(sample.expectedBrand));
    const brandNames = new Map<string, string>();
    for (const sample of selected) brandNames.set(normalizeBrandName(sample.predictedBrand!), sample.predictedBrand!);
    const perBrand = [...brandNames].map(([normalized, brand]) => {
      const brandPredictions = selected.filter((sample) => normalizeBrandName(sample.predictedBrand!) === normalized);
      const brandCorrect = brandPredictions.filter((sample) => sample.expectedBrand !== null
        && normalizeBrandName(sample.expectedBrand) === normalized);
      return {
        brand,
        predictionCount: brandPredictions.length,
        correctCount: brandCorrect.length,
        precision: brandCorrect.length / brandPredictions.length,
        coverage: rows.length ? brandPredictions.length / rows.length : 0,
      };
    }).sort((a, b) => b.predictionCount - a.predictionCount || a.brand.localeCompare(b.brand, 'es'));
    return {
      evaluationCount: rows.length,
      predictionCount: selected.length,
      correctCount: correctRows.length,
      precision: selected.length ? correctRows.length / selected.length : null,
      coverage: rows.length ? selected.length / rows.length : null,
      perBrand,
    };
  };
  const overall = summarize(samples);
  const autoEligibleBrands = overall.perBrand.filter((row) => row.predictionCount >= BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND
    && row.precision >= BRAND_AUTO_PRECISION_THRESHOLD).map((row) => row.brand);
  const sources = new Set(samples.flatMap((sample) => Object.keys(sample.sourcePredictions ?? {})));
  const bySource = [...sources].sort((a, b) => a.localeCompare(b, 'es')).map((source) => ({
    source,
    ...summarize(samples.map((sample) => ({ predictedBrand: sample.sourcePredictions?.[source] ?? null, expectedBrand: sample.expectedBrand }))),
  }));
  return {
    ...overall,
    precisionThreshold: BRAND_AUTO_PRECISION_THRESHOLD,
    minimumPredictionsPerBrand: BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND,
    autoEligibleBrands,
    bySource,
  };
}
