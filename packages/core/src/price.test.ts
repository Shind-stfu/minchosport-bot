import { describe, expect, it } from 'vitest';
import { addMargin, analyzePrices, extractShoeCode, formatCop, prepareOutgoingDescription, removeDozenPriceLines, replacePriceCandidates, replacePriceRanges } from './price.js';

describe('analyzePrices', () => {
  it.each([
    ['$60.000', 60000],
    ['$70', 70000],
    ['💲95', 95000],
    ['60000', 60000],
    ['60 mil', 60000],
    ['$60k', 60000],
    ['COP 60.000', 60000],
  ])('reconoce %s como COP %i', (text, amount) => {
    expect(analyzePrices(`Precio ${text}`).candidates[0]?.amountCop).toBe(amount);
    expect(analyzePrices(`Precio ${text}`).candidates[0]?.confidence).toBe('explicit');
  });

  it('marca un número sin etiqueta monetaria como ambiguo', () => {
    expect(analyzePrices('60.000').candidates[0]?.confidence).toBe('ambiguous');
  });

  it('excluye referencias, tallas y cantidades cercanas', () => {
    const result = analyzePrices('Ref 60.000 · Tallas 36-40 · 12 pares');
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
  });

  it('marca precios distintos como ambiguos', () => {
    expect(analyzePrices('Antes $80.000, precio $60.000').status).toBe('ambiguous');
  });

  it('does not automatically select a price tied to a previous or promotional value', () => {
    expect(analyzePrices('Precio anterior 60 mil').candidates[0]?.confidence).toBe('ambiguous');
    expect(analyzePrices('Oferta tenis $60.000').candidates[0]?.confidence).toBe('ambiguous');
  });

  it('no acepta un prefijo de precio cuando aparece una fracción decimal no admitida', () => {
    expect(analyzePrices('Precio $60.000,50').candidates).toHaveLength(0);
  });

  it('decodifica cifras de precio en emoji de tecla y admite la palabra pegada al importe', () => {
    const original = '*💲 8️⃣0️⃣.0️⃣0️⃣0️⃣Cuadre✅*';
    const analysis = analyzePrices(original);
    expect(analysis.candidates).toMatchObject([{ amountCop: 80000, confidence: 'explicit', kind: 'unknown' }]);
    const replaced = replacePriceCandidates(original, analysis.candidates, 90000);
    expect(replaced).toBe('*💲90.000 Cuadre✅*');
    expect(prepareOutgoingDescription(replaced)).toBe('*$90.000 CUADRE*');
  });

  it('procesa la descripción completa con precio en emojis y deja la salida estable al prepararla otra vez', () => {
    const original = '*New❤️New*\n*❗ Nike Air Max 90 Patta ❗*\n*❤️Caballero❤️*\n*👑Tallas Caballero 40 41 42 43 44👑*\n*💲 8️⃣0️⃣.0️⃣0️⃣0️⃣Cuadre✅*';
    const analysis = analyzePrices(original);
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates).toMatchObject([{ amountCop: 80000 }]);
    const outgoing = prepareOutgoingDescription(replacePriceCandidates(original, analysis.candidates, 90000));
    expect(outgoing).toBe('*NEW NEW*\n*NIKE AIR MAX 90 PATTA*\n*CABALLERO*\n*TALLAS CABALLERO 40 41 42 43 44*\n*$90.000 CUADRE*');
    expect(prepareOutgoingDescription(outgoing)).toBe(outgoing);
  });

  it('no altera números de modelo al cambiar solo el rango aprobado', () => {
    const text = 'Air Max 270 · Tallas 36-40 · Precio $60.000';
    const candidate = analyzePrices(text).candidates[0]!;
    expect(replacePriceRanges(text, [candidate], formatCop(addMargin(candidate.amountCop, 10000))))
      .toBe('Air Max 270 · Tallas 36-40 · Precio $70.000');
  });

  it('rechaza rangos solapados o fuera del texto', () => {
    expect(() => replacePriceRanges('abc', [{ start: 0, end: 2 }, { start: 1, end: 3 }], '$1')).toThrow();
    expect(() => replacePriceRanges('abc', [{ start: 2, end: 8 }], '$1')).toThrow();
  });

  it.each([
    ['COD 143 NIKE HOMBRE💲70.000 RECARGA🔥🔥', 'COD 143 NIKE HOMBRE💲80.000 RECARGA🔥🔥'],
    ['COD 993 NEW BALANCE PLUS DAMA💲90.000 RECARGA❤️😍', 'COD 993 NEW BALANCE PLUS DAMA💲100.000 RECARGA❤️😍'],
    ['GUAYO PREDATOR\n$110.000', 'GUAYO PREDATOR\n$120.000'],
    ['RETRO 40\nHOMBRE👨🏻\n$95.000', 'RETRO 40\nHOMBRE👨🏻\n$105.000'],
  ])('ajusta únicamente el precio del formato de proveedor: %s', (original, expected) => {
    const analysis = analyzePrices(original);
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]?.confidence).toBe('explicit');
    const output = replacePriceCandidates(original, analysis.candidates, analysis.candidates[0]!.amountCop + 10000);
    expect(output).toBe(expected);
  });

  it('recognizes and expands the abbreviated price from the supplier listing', () => {
    const original = '*NIKE DUNK LOW JARRITO / SB* HOMBRE _COD: 987👑_ EUR 41 AL 44 PARES *$70👟*';
    const analysis = analyzePrices(original);
    expect(analysis.candidates.map((candidate) => candidate.amountCop)).toEqual([70000]);
    expect(replacePriceCandidates(original, analysis.candidates, 80000))
      .toBe('*NIKE DUNK LOW JARRITO / SB* HOMBRE _COD: 987👑_ EUR 41 AL 44 PARES *$80.000👟*');
  });

  it('clasifica por separado PRECIO y CAJA y permite reemplazar ambos importes', () => {
    const original = 'Vans dama\n*PRECIO $45.000*👟\n*CAJA $35.000📦*';
    const candidates = analyzePrices(original).candidates;
    expect(candidates.map(({ amountCop, kind, confidence }) => ({ amountCop, kind, confidence }))).toEqual([
      { amountCop: 45000, kind: 'price', confidence: 'explicit' },
      { amountCop: 35000, kind: 'box', confidence: 'explicit' },
    ]);
    expect(replacePriceCandidates(original, candidates, [55000, 40000]))
      .toBe('Vans dama\n*PRECIO $55.000*👟\n*CAJA $40.000📦*');
  });

  it.each([
    ['1057 *NIKE MP  DAMA $80.000🚀🚀* _Por caja $70.000📦📦_', 80000, 70000],
    ['1058 *ADIDAS REPÓNSE DAMA $75.000🚀🚀* _Por caja $65.000📦📦_', 75000, 65000],
    ['1059 *ADIDAS REPÓNSE DAMA $75.000🚀🚀* _Por caja $65.000📦📦_', 75000, 65000],
  ])('separa precio principal y caja en el mismo renglón: %s', (source, price, box) => {
    const candidates = analyzePrices(source).candidates;
    expect(candidates.map((candidate) => ({ kind: candidate.kind, amount: candidate.amountCop }))).toEqual([{ kind: 'price', amount: price }, { kind: 'box', amount: box }]);
    const outgoing = prepareOutgoingDescription(replacePriceCandidates(source, candidates, [Number(price) + 10000, Number(box) + 5000]));
    expect(analyzePrices(outgoing).candidates.map((candidate) => candidate.amountCop)).toEqual([Number(price) + 10000, Number(box) + 5000]);
  });

  it('conserva una etiqueta de caja posterior al importe cuando no encabeza otro importe', () => {
    expect(analyzePrices('$65.000 por caja').candidates[0]?.kind).toBe('box');
    expect(analyzePrices('CAJA $65.000 / PRECIO $75.000').candidates.map((candidate) => candidate.kind)).toEqual(['box', 'price']);
  });

  it('reconoce el importe de CAJA aun sin símbolo monetario', () => {
    const candidate = analyzePrices('Vans dama\nPRECIO 45.000\nCAJA 35.000').candidates;
    expect(candidate.map(({ amountCop, kind }) => ({ amountCop, kind }))).toEqual([
      { amountCop: 45000, kind: 'price' }, { amountCop: 35000, kind: 'box' },
    ]);
  });

  it('ignora y quita la línea de DOCENA del texto que se publicará, conservando el original', () => {
    const original = '🦅REF 292 D🦅\nPRECIO $55.000👟\nDOCENA $50.000📦';
    expect(analyzePrices(original).candidates.map(({ amountCop, kind }) => ({ amountCop, kind })))
      .toEqual([{ amountCop: 55000, kind: 'price' }]);
    expect(removeDozenPriceLines(original)).toBe('🦅REF 292 D🦅\nPRECIO $55.000👟');
    expect(original).toContain('DOCENA $50.000📦');
  });

  it.each([
    'CAJA Y DOCENA $50.000', 'Caja y docena: 50000', 'CAJA / DOCENA 💲50',
    'PRECIO POR DOCENAS $50.000', '50.000 POR DOCENA', 'Venta por docena',
    'DOCENA', 'docenas', '*CAJA Y _DOCENA_* $5', 'CAJA Y DO_CE_NA $50.000',
    'CAJA Y DO\u200bCENA $50.000', 'ＣＡＪＡ Ｙ ＤＯＣＥＮＡ $50.000',
  ])('elimina cualquier línea con docena, sin importar el formato: %s', (line) => {
    const source = `COD 292\nPRECIO $55.000\n${line}`;
    expect(analyzePrices(source).candidates.map((candidate) => candidate.amountCop)).toEqual([55000]);
    expect(prepareOutgoingDescription(source)).toBe('*COD 292*\n*PRECIO $55.000*');
    expect(prepareOutgoingDescription(prepareOutgoingDescription(source))).toBe('*COD 292*\n*PRECIO $55.000*');
  });

  it('conserva las líneas de PRECIO y CAJA independientes y los saltos de Windows', () => {
    const source = 'PRECIO $55.000\r\nCAJA $45.000\r\nCAJA Y DOCENA $40.000\r\nTALLAS 36-40';
    expect(analyzePrices(source).candidates.map((candidate) => candidate.kind)).toEqual(['price', 'box']);
    expect(prepareOutgoingDescription(source)).toBe('*PRECIO $55.000*\r\n*CAJA $45.000*\r\n*TALLAS 36-40*');
  });

  it('elimina emojis de la descripción enviada, conserva formato y normaliza 💲 a $', () => {
    expect(prepareOutgoingDescription('🦅REF 292 D🦅\n*PRECIO 💲55.000*👟\nNIKE🔥HOMBRE👨🏻‍🦱 RECARGA🔥🔥'))
      .toBe('*REF 292 D*\n*PRECIO $55.000*\n*NIKE HOMBRE RECARGA*');
  });

  it('quita también la línea de docena y conserva el texto comercial que se publicará', () => {
    const original = '🦅REF 292 D🦅\nPRECIO $55.000👟\nDOCENA $50.000📦';
    expect(prepareOutgoingDescription(original)).toBe('*REF 292 D*\n*PRECIO $55.000*');
    expect(original).toBe('🦅REF 292 D🦅\nPRECIO $55.000👟\nDOCENA $50.000📦');
  });

  it('converts keycap digits to ordinary numbers and formats every outgoing line in uppercase bold', () => {
    expect(prepareOutgoingDescription('*New❤️New*\n*❗ Nike Air Max 90 Patta ❗*\n❤️Caballero❤️\nTallas 40 41 42 43 44'))
      .toBe('*NEW NEW*\n*NIKE AIR MAX 90 PATTA*\n*CABALLERO*\n*TALLAS 40 41 42 43 44*');
    expect(prepareOutgoingDescription('Tallas 4️⃣0️⃣ 4️⃣1️⃣')).toBe('*TALLAS 40 41*');
  });

  it('permite margen cero y conserva la forma de la moneda recibida', () => {
    const original = 'COD 001 AB-7 💲60.000';
    const candidate = analyzePrices(original).candidates[0]!;
    expect(addMargin(candidate.amountCop, 0)).toBe(60000);
    expect(replacePriceCandidates(original, [candidate], addMargin(candidate.amountCop, 0))).toBe('COD 001 AB-7 💲60.000');
  });

  it('conserva cada descripción de proveedor al aplicar márgenes de 0, 5.000 y 10.000', () => {
    const examples = [
      'COD 143 NIKE HOMBRE💲70.000 RECARGA🔥🔥',
      'COD 993 NEW BALANCE PLUS DAMA💲90.000 RECARGA❤️😍',
      'GUAYO PREDATOR\n$110.000',
      'RETRO 40\nHOMBRE👨🏻\n$95.000',
    ];
    for (const original of examples) for (const margin of [0, 5000, 10000]) {
      const candidate = analyzePrices(original).candidates[0]!;
      const output = replacePriceCandidates(original, [candidate], addMargin(candidate.amountCop, margin));
      const outputCandidate = analyzePrices(output).candidates[0]!;
      expect(outputCandidate.amountCop).toBe(candidate.amountCop + margin);
      expect(original.slice(0, candidate.start) + original.slice(candidate.end))
        .toBe(output.slice(0, outputCandidate.start) + output.slice(outputCandidate.end));
    }
  });

  it.each([
    ['COD 001 NIKE $60.000', '001'],
    ['CÓDIGO AB-143 · precio $60.000', 'AB-143'],
    ['REF X99 · 💲70.000', 'X99'],
    ['SKU 0007 · COP 65.000', '0007'],
  ])('extrae el código %s', (text, expected) => {
    expect(extractShoeCode(text)).toMatchObject({ code: expected });
  });

  it.each([
    ['1057 *NIKE MP  DAMA $80.000🚀🚀* _Por caja $70.000📦📦_', '1057'],
    ['1058 *ADIDAS REPÓNSE DAMA $75.000🚀🚀* _Por caja $65.000📦📦_', '1058'],
    ['1059 *ADIDAS REPÓNSE DAMA $75.000🚀🚀*_Por caja $65.000📦📦_', '1059'],
    ['*1059*ADIDAS REPÓNSE DAMA $75.000', '1059'],
    ['🔥 *0019* NIKE HOMBRE $70.000', '0019'],
    ['015-81 ADIDAS MUJER $75.000', '015-81'],
    ['  1059 - ADIDAS DAMA\nPRECIO $75.000', '1059'],
  ])('reconoce una referencia al principio del nombre: %s', (text, code) => {
    expect(extractShoeCode(text)).toEqual({ code, candidates: [code] });
  });

  it.each([
    '75000 ADIDAS DAMA', '$75.000 ADIDAS DAMA', '75.000 ADIDAS DAMA',
    '100 pares de tenis', '1059 COP', '1059 unidades disponibles',
    '36 ADIDAS DAMA', '360 tallas disponibles', '1059ADIDAS DAMA', '1059.50 ADIDAS',
  ])('no convierte un precio, talla o cantidad inicial en código: %s', (text) => {
    expect(extractShoeCode(text).code).toBeNull();
  });

  it('conserva la prioridad de las etiquetas explícitas y revisa referencias implícitas contradictorias', () => {
    expect(extractShoeCode('1059 ADIDAS DAMA · REF 123').code).toBe('123');
    expect(extractShoeCode('1059 ADIDAS · MUJER 015-81').code).toBeNull();
    expect(extractShoeCode('1059 ADIDAS · COD 123 · REF 456').code).toBeNull();
    const source = '1059 *ADIDAS REPÓNSE DAMA $75.000🚀🚀*_Por caja $65.000📦📦_';
    expect(analyzePrices(source).candidates.map((candidate) => ({ amount: candidate.amountCop, kind: candidate.kind }))).toEqual([{ amount: 75000, kind: 'price' }, { amount: 65000, kind: 'box' }]);
  });

  it('no inventa códigos a partir de modelos ni resuelve códigos contradictorios', () => {
    expect(extractShoeCode('RETRO 40 · HOMBRE · $95.000').code).toBeNull();
    expect(extractShoeCode('COD 143 y REF 993').code).toBeNull();
  });

  it('reconoce códigos numéricos con guion después de la categoría de género', () => {
    const text = '*JORDAN ROSADA GRIS NEGRO* *MUJER 015-81* *$70.000* *RECARGA 🔥🔥🔥*';
    expect(extractShoeCode(text)).toEqual({ code: '015-81', candidates: ['015-81'] });
    expect(extractShoeCode('*MUJER 096-215*')).toEqual({ code: '096-215', candidates: ['096-215'] });
    expect(extractShoeCode('HOMBRE 001-007 · Precio $70.000')).toEqual({ code: '001-007', candidates: ['001-007'] });
    expect(extractShoeCode('*HOMBRE🕴️106-5*')).toEqual({ code: '106-5', candidates: ['106-5'] });
    expect(extractShoeCode('*BAPE FLIP STA CAFE BEIGE*\n*HOMBRE 🕴️174-54*\n*$100.000*NUEVO*🔥🔥')).toEqual({ code: '174-54', candidates: ['174-54'] });
    expect(extractShoeCode('*MUJER 👧😍 129-17*')).toEqual({ code: '129-17', candidates: ['129-17'] });
    expect(analyzePrices('*MUJER 096-215*').candidates).toEqual([]);
    expect(analyzePrices('*MUJER 096-215*\nPRECIO $70.000').candidates.map((candidate) => candidate.amountCop)).toEqual([70000]);
    expect(extractShoeCode('JORDAN MUJER 40-44 · Precio $95.000').code).toBeNull();
    expect(extractShoeCode('MUJER 096-2150').code).toBeNull();
    expect(extractShoeCode('HOMBRE🕴️106-5-2').code).toBeNull();
    expect(extractShoeCode('RETRO 40 · HOMBRE · $95.000').code).toBeNull();
    expect(extractShoeCode('MUJER 015-81 · COD 123').code).toBe('123');
  });

  it('deja en revisión los códigos con guion que se contradicen', () => {
    expect(extractShoeCode('MUJER 015-81 · HOMBRE 013-70').code).toBeNull();
    expect(extractShoeCode('MUJER 096-215 · HOMBRE 096-216').code).toBeNull();
  });
});
