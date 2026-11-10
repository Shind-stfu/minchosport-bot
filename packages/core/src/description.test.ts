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

  it('leaves the description alone when no code is available', () => {
    expect(prependBrandBeforeShoeCode('AF1 FLORETTE\nPRECIO $60.000', 'Nike'))
      .toBe('AF1 FLORETTE\nPRECIO $60.000');
  });

  it('matches multiword brand names at word boundaries', () => {
    expect(descriptionContainsBrand('NEW BALANCE REF 4795', 'New Balance')).toBe(true);
    expect(descriptionContainsBrand('NEWBALANCE REF 4795', 'New Balance')).toBe(false);
  });
});
