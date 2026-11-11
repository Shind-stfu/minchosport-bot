import { describe, expect, it } from 'vitest';
import { cosineSimilarity, normalizeSoleMatchEmbedding, rankSoleMatchReferences } from './solematch-clip.js';

describe('SoleMatch CLIP reference retrieval', () => {
  it('normalizes vectors and ranks the closest verified brand photos', () => {
    const query = normalizeSoleMatchEmbedding([4, 0]);
    const matches = rankSoleMatchReferences(query, [
      { brand: 'Nike', embedding: normalizeSoleMatchEmbedding([3, 1]) },
      { brand: 'Jordan', embedding: normalizeSoleMatchEmbedding([0, 5]) },
    ]);
    expect(matches[0]?.brand).toBe('Nike');
    expect(matches[0]?.score).toBeGreaterThan(matches[1]!.score);
  });

  it('returns zero for embeddings with incompatible shapes and rejects invalid vectors', () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
    expect(() => normalizeSoleMatchEmbedding([0, 0])).toThrow('vector inválido');
  });
});
