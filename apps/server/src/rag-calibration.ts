import { createHash } from 'node:crypto';
import { normalizeBrandName } from './brand-candidates.js';
import { BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND, BRAND_AUTO_PRECISION_THRESHOLD, evaluateBrandSuggestions } from './brand-evaluation.js';
import { defaultThresholds, qualifies, type RagMatch } from './brand-rag.js';

export type RagTrial = { key: string; expected: string | null; baseline: string | null; match: RagMatch | null;
  retrievalMs: number; baselineMs: number; retrievalRss: number; baselineRss: number };
export function calibrationPartition(key: string) {
  return createHash('sha256').update('rag-calibration-v1:' + key).digest()[0]! % 3 === 0 ? 'tune' : 'test';
}

export function calibrateRag(trials: RagTrial[]) {
  const tuning = trials.filter(t => calibrationPartition(t.key) === 'tune');
  const test = trials.filter(t => calibrationPartition(t.key) === 'test');
  const metrics = (rows: RagTrial[], limits: typeof defaultThresholds) => evaluateBrandSuggestions(rows.map(t =>
    ({ predictedBrand: qualifies(t.match, limits) ? t.match.brand : null, expectedBrand: t.expected })));
  let limits = defaultThresholds;
  let best = 0;
  for (const score of [0.9, 0.85, 0.8, 0.75]) for (const margin of [0.1, 0.06, 0.04]) {
    const metric = metrics(tuning, { score, margin });
    if ((metric.precision ?? 0) >= BRAND_AUTO_PRECISION_THRESHOLD && metric.correctCount > best) {
      best = metric.correctCount;
      limits = { score, margin };
    }
  }
  const retrieval = metrics(test, limits);
  const baseline = evaluateBrandSuggestions(test.map(t => ({ predictedBrand: t.baseline, expectedBrand: t.expected })));
  const eligible = retrieval.perBrand.filter(row => {
    const matches = test.filter(t => qualifies(t.match, limits) && normalizeBrandName(t.match.brand) === normalizeBrandName(row.brand));
    return best > 0 && row.predictionCount >= BRAND_AUTO_MIN_PREDICTIONS_PER_BRAND && row.precision >= BRAND_AUTO_PRECISION_THRESHOLD
      && matches.reduce((s,t) => s+t.retrievalMs,0) < matches.reduce((s,t) => s+t.baselineMs,0);
  }).map(row => normalizeBrandName(row.brand));
  const shortcut = (t: RagTrial) => qualifies(t.match, limits) && eligible.includes(normalizeBrandName(t.match.brand));
  const baselineMs = test.reduce((s,t) => s+t.baselineMs,0);
  const projectedMs = test.reduce((s,t) => s+t.retrievalMs+(shortcut(t) ? 0 : t.baselineMs),0);
  return { tuningCount: tuning.length, evaluationCount: test.length, retrieval, baseline, baselineMs, projectedMs,
    possibleSkips: test.filter(t => qualifies(t.match, limits)).length, calibratedSkips: projectedMs < baselineMs ? test.filter(shortcut).length : 0,
    policy: { ...limits, brands: projectedMs < baselineMs ? eligible : [] } };
}
