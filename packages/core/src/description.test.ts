import { describe, expect, it } from 'vitest';
import { descriptionContainsBrand, prependBrandBeforeShoeCode } from './description.js';

describe('brand placement in outgoing descriptions', () => {
  it('places the detected brand before the labeled reference line', () => {
    expect(prependBrandBeforeShoeCode('REF 4795 D\nPRECIO $60.000', 'Nike', '4795'))
      .toBe('Nike REF 4795 D\nPRECIO $60.000');
  });

  it('does not duplicate a brand already before the code', () => {
    expect(prependBrandBeforeShoeCode('NIKE REF 4795 D\nPRECIO $60.000', 'Nike', '4795'))
      .toBe('NIKE REF 4795 D\nPRECIO $60.000');
  });

  it('does not duplicate a brand appearing after the code', () => {
    expect(prependBrandBeforeShoeCode('COD 1005 NIKE PRESTO DAMA\n$70.000', 'Nike', '1005'))
      .toBe('COD 1005 NIKE PRESTO DAMA\n$70.000');
  });

  it('removes a shortened brand prefix already in the title', () => {
    expect(prependBrandBeforeShoeCode('COD 168 LE COQ HOMBRE 😍❤️\n💲85.000', 'LE COQ SPORTIF', '168'))
      .toBe('LE COQ SPORTIF COD 168 HOMBRE 😍❤️\n💲85.000');
  });

  it('cleans duplicate aliases when the canonical brand is already present', () => {
    expect(prependBrandBeforeShoeCode('LE COQ SPORTIF COD 168 LE COQ HOMBRE\n$85.000', 'LE COQ SPORTIF', '168'))
      .toBe('LE COQ SPORTIF COD 168 HOMBRE\n$85.000');
  });

  it('removes registered brand aliases from the title', () => {
    expect(prependBrandBeforeShoeCode('COD 168 COQ SPORTIF HOMBRE\n$85.000', 'LE COQ SPORTIF', '168', ['COQ SPORTIF']))
      .toBe('LE COQ SPORTIF COD 168 HOMBRE\n$85.000');
  });

  it('leaves the description alone when no code is available', () => {
    expect(prependBrandBeforeShoeCode('AF1 FLORETTE\nPRECIO $60.000', 'Nike'))
      .toBe('AF1 FLORETTE\nPRECIO $60.000');
  });

  it('matches multiword brand names at word boundaries', () => {
    expect(descriptionContainsBrand('NEW BALANCE REF 4795', 'New Balance')).toBe(true);
    expect(descriptionContainsBrand('NEWBALANCE REF 4795', 'New Balance')).toBe(false);
  });
});
