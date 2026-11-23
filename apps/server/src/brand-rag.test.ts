import { describe, expect, it } from 'vitest';
import { exactBrand, matchShoes, matchShoesTrial, qualifies } from './brand-rag.js';

describe('recuperación visual de marcas', () => {
  it('reutiliza solo fotografías idénticas verificadas sin conflictos ni evaluación', () => {
    const photo = { id: 'a', sha: 'hash', file: 'a', product: 'p', supplier: null, code: null, brand: 'Jordan', split: 'reference' as const };
    const group = { key: 'x', photos: [photo], reserved: false, conflict: false, brand: 'Jordan' };
    expect(exactBrand(group, 'b', 'hash')).toBe('Jordan');
    expect(exactBrand(group, 'b', 'other')).toBeNull();
    expect(exactBrand({ ...group, reserved: true }, 'b', 'hash')).toBeNull();
    expect(exactBrand({ ...group, conflict: true }, 'b', 'hash')).toBeNull();
  });
  it('requiere varias referencias independientes y acuerdo entre zapatos', () => {
    const refs = [
      ...['a','b','c'].map(key => ({ key, brand: 'Nike', vectors: [[1, 0]] })),
      ...['d','e','f'].map(key => ({ key, brand: 'Puma', vectors: [[0, 1]] })),
    ];
    expect(qualifies(matchShoes([[1, 0]], refs), { score: 0.8, margin: 0.04 })).toBe(true);
    expect(matchShoes([[1, 0], [0, 1]], refs)).toBeNull();
    expect(matchShoes([[1, 0]], refs.slice(0, 2))).toBeNull();
  });
  it('en modo de prueba devuelve la referencia más cercana con pocos ejemplos y varios zapatos', () => {
    const refs = [
      { key: 'a', brand: 'Nike', vectors: [[1, 0]] },
      { key: 'b', brand: 'Adidas', vectors: [[0, 1]] },
    ];
    expect(matchShoes([[1, 0]], refs)).toBeNull();
    expect(matchShoesTrial([[1, 0]], refs)).toMatchObject({ brand: 'Nike', supportCount: 1, score: 1 });
    expect(matchShoesTrial([[1, 0], [1, 0]], refs)?.brand).toBe('Nike');
  });
});
