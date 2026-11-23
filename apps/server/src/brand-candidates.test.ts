import { describe, expect, it } from 'vitest';
import { extractBrandCandidates, extractCatalogBrandCandidates, normalizeBrandName, resolveVisionBrandConsensus } from './brand-candidates.js';

describe('open-vocabulary brand candidates', () => {
  it('does not let a logo on a background box settle conflicting shoe readings', () => {
    const answer = [
      { brand: 'Saucony', evidence: 'Logo en el lateral de la zapatilla', uncertain: false },
      { brand: 'Saucony', evidence: 'Texto en la zapatilla', uncertain: false },
      { brand: 'New Balance', evidence: 'Logo visible en la caja roja en el fondo', uncertain: false },
      { brand: 'On', evidence: 'Logo en el lateral de la zapatilla', uncertain: false },
    ].map((item) => JSON.stringify(item)).join(' · ');
    expect(resolveVisionBrandConsensus(answer).brand).toBeNull();
    expect(resolveVisionBrandConsensus(answer).disagreement).toBe(true);
  });
  it('extracts a previously unseen brand from uppercase or title-case descriptions', () => {
    expect(extractBrandCandidates('TENIS HOKA PARA DAMA · TALLAS 36 A 40')).toContain('HOKA');
    expect(extractBrandCandidates('Zapatos On Running para hombre')).toContain('On Running');
  });

  it('reads lowercase logo text from OCR and recognizes saved aliases', () => {
    expect(extractBrandCandidates('nike · cod 143', ['New Balance', 'NB'], { allowLowercaseWords: true })).toContain('nike');
    expect(extractBrandCandidates('Marca NB', ['New Balance', 'NB'])).toContain('NB');
    expect(normalizeBrandName('NÉW  BALANCE')).toBe('new balance');
  });

  it('filters common catalogue words instead of treating them as brand candidates', () => {
    const candidates = extractBrandCandidates('BUENAS TARDES · TENIS DISPONIBLES · PRECIO 60000');
    expect(candidates).not.toContain('BUENAS TARDES');
    expect(candidates).not.toContain('TENIS');
    expect(candidates).not.toContain('PRECIO');
  });

  it('learns repeated open-vocabulary candidates from incoming catalogue titles', () => {
    const candidates = extractCatalogBrandCandidates(['NIKE AIR FORCE', 'NIKE V5R', 'ADIDAS SAMBA'], ['Puma'], 8);
    expect(candidates).toContain('Puma');
    expect(candidates).toContain('NIKE');
    expect(candidates).not.toContain('ADIDAS');
  });
});
