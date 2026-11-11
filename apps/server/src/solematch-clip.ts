import type { BrandCandidateScore } from './image-brand-inspection.js';
import { rankBrandReferences } from './brand-reference-ranking.js';

export function normalizeSoleMatchEmbedding(values: ArrayLike<number>) {
  const vector = Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!vector.length || !Number.isFinite(norm) || norm === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('SoleMatch CLIP devolvió un vector inválido.');
  }
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return dot;
}

export function rankSoleMatchReferences(query: number[], references: Array<{ brand: string; embedding: number[] }>): BrandCandidateScore[] {
  return rankBrandReferences(references.map((reference) => ({ brand: reference.brand, score: cosineSimilarity(query, reference.embedding) })));
}
