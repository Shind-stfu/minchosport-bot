export type PriceCandidate = {
  start: number;
  end: number;
  raw: string;
  amountCop: number;
  kind: 'price' | 'box' | 'unknown';
  context: string;
  confidence: 'explicit' | 'ambiguous';
  reason: string;
};

export type PriceAnalysis = {
  candidates: PriceCandidate[];
  excluded: Array<{ raw: string; reason: string }>;
  status: 'no_price' | 'ready_for_review' | 'ambiguous';
};

const PRICE_DIGIT = String.raw`(?:\d\uFE0F?\u20E3|\d)`;
const AMOUNT = String.raw`(?:${PRICE_DIGIT}{1,3}(?:[. ]${PRICE_DIGIT}{3})+|${PRICE_DIGIT}+)(?:\s*(?:mil|k))?`;
const TOKEN = new RegExp(String.raw`(?:(?:(?<![\p{L}\p{N}_])COP\s*|(?<!\p{N})\$\s*|(?<!\p{N})💲\s*)${AMOUNT}|(?<![\p{L}\p{N}_])${AMOUNT})(?![,.]\s*\d)`, 'giu');
const EXCLUDED = /\b(?:tallas?|sizes?|ref(?:erencia)?|modelo|sku|cod(?:igo)?|código|par(?:es)?|unidades?|cantidad|docena|caja|env[ií]o|flete|tachado|descuento|cuenta|nequi|daviplata|tel[eé]fono|whats?app|us|eu|cm|mm|kg|gr)\b/giu;
const PRICE_LABEL = /(?:\bprecio\b|\bvalor\b|\bpor\s+par\b|\bpar\s*:?)/i;
const CODE_LABEL = /(?:^|[^\p{L}\p{N}_])(?:COD(?:IGO)?|C[ÓO]DIGO|REF(?:ERENCIA)?|SKU)\s*[:#.-]?\s*([A-Z0-9][A-Z0-9-]{0,31})(?![\p{L}\p{N}_])/giu;
const GENDER_CODE = /(?:^|[^\p{L}\p{N}_])(?:HOMBRE|MUJER|DAMA|CABALLERO)(?:\s|[\p{Extended_Pictographic}\uFE0F\u200D\p{Emoji_Modifier}])+(\d{3}-\d{1,3})(?![\p{L}\p{N}_-])/giu;
const LEADING_CODE = /^[\s*_~`#\p{Extended_Pictographic}\uFE0F\u200D\p{Emoji_Modifier}]*([0-9]{3,6}(?:-[0-9]{1,6})?)(?![\p{L}\p{N}_.,/-])[\s*_~`:.–—-]+(?=\p{L})/iu;
const DOZEN_LABEL = /docena/iu;
const EMOJI_SEQUENCE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;

function parseAmount(token: string): number | null {
  const compact = token.replace(/(\d)\uFE0F?\u20E3/gu, '$1').trim().replace(/^COP\s*/i, '').replace(/^(?:\$|💲)\s*/, '');
  const hasSuffixMultiplier = /(?:\s*mil|\s*k)$/i.test(compact);
  const hasCurrency = /^(?:COP\b|\$|💲)/i.test(token.trim());
  const multiplier = hasSuffixMultiplier ? 1000 : 1;
  const number = compact.replace(/(?:\s*mil|\s*k)$/i, '').trim();
  if (/\d[.]\d{3}/.test(number) && !/^\d{1,3}(?:[. ]\d{3})+$/.test(number)) return null;
  const digits = number.replace(/[. ]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let amount = Number(digits) * multiplier;
  // Colombian footwear listings commonly abbreviate thousands as "$70" for "$70.000".
  // Apply this only with an explicit currency symbol and a plausible 2-3 digit price.
  if (!hasSuffixMultiplier && hasCurrency && /^\d{2,3}$/.test(number) && amount >= 20 && amount <= 999) amount *= 1000;
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function hasExcludedContext(text: string, start: number, end: number): string | undefined {
  const left = text.slice(Math.max(0, start - 38), start);
  const right = text.slice(end, Math.min(text.length, end + 28));
  EXCLUDED.lastIndex = 0;
  const leftMatches = [...left.matchAll(EXCLUDED)];
  const rightMatches = [...right.matchAll(EXCLUDED)];
  const leftMatch = leftMatches.at(-1)?.[0];
  const rightMatch = rightMatches[0]?.[0];
  if (leftMatch && left.slice((left.lastIndexOf(leftMatch) + leftMatch.length)).trim().length < 13) {
    return `Contexto cercano: ${leftMatch}`;
  }
  if (rightMatch && right.slice(0, right.indexOf(rightMatch)).trim().length < 5) {
    return `Contexto cercano: ${rightMatch}`;
  }
  return undefined;
}

function hasValidPriceBoundary(text: string, raw: string, end: number): boolean {
  const next = text[end] ?? '';
  if (!/[\p{L}\p{N}_]/u.test(next)) return true;
  // Some suppliers put a word directly after keycap-emoji amounts (e.g. 💲8️⃣0️⃣.0️⃣0️⃣0️⃣Cuadre).
  return /^(?:COP|\$|💲)/iu.test(raw.trim()) && /\d\uFE0F?\u20E3/u.test(raw);
}

function priceKind(text: string, start: number): PriceCandidate['kind'] {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const labels: Array<{ kind: 'price' | 'box'; index: number; end: number }> = [];
  const matcher = /\b(precio|valor|venta|por\s+par|cajas?)\b/giu;
  for (const match of line.matchAll(matcher)) {
    const label = match[0].toLocaleLowerCase('es');
    labels.push({ kind: /^cajas?$/u.test(label) ? 'box' : 'price', index: lineStart + (match.index ?? 0), end: lineStart + (match.index ?? 0) + match[0].length });
  }
  const labelsForNextAmount = labels.filter((label) => label.index > start && [...line.slice(label.end - lineStart).matchAll(new RegExp(TOKEN.source, TOKEN.flags))]
    .some((match) => { const amount = parseAmount(match[0]); return amount !== null && amount >= 20000 && amount <= 1000000; }));
  const nearest = labels
    // In "$75.000 ... Por caja $65.000", CAJA belongs to the next amount.
    .filter((label) => !labelsForNextAmount.includes(label))
    .map((label) => ({ ...label, distance: start < label.index ? label.index - start : start - label.end }))
    .filter((label) => label.distance <= 48)
    .sort((left, right) => left.distance - right.distance)[0];
  const primaryBeforeBox = labelsForNextAmount.some((label) => label.kind === 'box') && /^(?:\$|💲|COP\b)/iu.test(text.slice(start));
  return nearest?.kind ?? (primaryBeforeBox ? 'price' : 'unknown');
}

function containsDozenReference(line: string): boolean {
  // Also catch combined labels, plural, formatting and invisible separators.
  return DOZEN_LABEL.test(line.normalize('NFKC').replace(/[*_~`\u200B-\u200D\uFEFF]/gu, ''));
}

/** Removes every line mentioning docena, even without an amount or with a combined CAJA label. */
export function removeDozenPriceLines(text: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r\n|[\r\n\u2028\u2029]/u).filter((line) => !containsDozenReference(line)).join(newline);
}

/** Removes decorative emoji from outbound descriptions while preserving 💲 as a readable dollar sign. */
export function stripOutgoingEmojis(text: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const withoutEmoji = text.replace(/(\d)\uFE0F?\u20E3/gu, '$1').replace(/💲/gu, '$').replace(EMOJI_SEQUENCE, (emoji, offset: number, source: string) => {
    const before = source[offset - 1] ?? '';
    const after = source[offset + emoji.length] ?? '';
    return /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after) ? ' ' : '';
  });
  return withoutEmoji
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t ]{2,}/gu, ' '))
    .join(newline);
}

/** Applies the agreed cleanup rules in a stable order before saving or sending a caption. */
export function prepareOutgoingDescription(text: string): string {
  const clean = stripOutgoingEmojis(removeDozenPriceLines(text))
    .replace(/((?:\$|COP)\s*\d+(?:[. ]\d{3})*)(?=\p{L})/giu, '$1 ');
  const newline = clean.includes('\r\n') ? '\r\n' : '\n';
  return clean.split(/\r?\n/u).map((line) => {
    const content = line.replace(/[*_~`]/gu, '').trim().toLocaleUpperCase('es-CO');
    return content ? `*${content}*` : '';
  }).join(newline);
}

export function analyzePrices(text: string): PriceAnalysis {
  const candidates: PriceCandidate[] = [];
  const excluded: PriceAnalysis['excluded'] = [];
  TOKEN.lastIndex = 0;

  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (!hasValidPriceBoundary(text, raw, end)) continue;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', start);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/u, '');
    if (containsDozenReference(line)) {
      excluded.push({ raw, reason: 'Importe de docena: se elimina de la descripción publicada.' });
      continue;
    }
    const amountCop = parseAmount(raw);
    if (!amountCop || amountCop < 20000 || amountCop > 1000000) continue;

    const hasCurrency = /^(?:COP|\$|💲)/i.test(raw.trim());
    const kind = priceKind(text, start);
    const excludedReason = hasCurrency || kind !== 'unknown' ? undefined : hasExcludedContext(text, start, end);
    if (excludedReason) {
      excluded.push({ raw, reason: excludedReason });
      continue;
    }

    const context = text.slice(Math.max(0, start - 38), Math.min(text.length, end + 28)).replace(/\s+/g, ' ').trim();
    const before = text.slice(Math.max(0, start - 24), start);
    const after = text.slice(end, Math.min(text.length, end + 12));
    const hasPriceLabel = hasCurrency || kind !== 'unknown' || /(?:\bprecio\b|\bvalor\b|\bpor\s+par\b|\bpar\s*:?)[^\S\r\n]*(?:(?:de|del|:)?\s*)$/i.test(before)
      || /^\s*(?:COP\s*)?(?:\$\s*)?(?:COP\b)?/i.test(after) && PRICE_LABEL.test(before);
    const specialPriceContext = /\b(?:antes|anterior|hoy|descuento|oferta|promo(?:ci[oó]n)?|tachado|combo|por\s+docena)\b/i.test(context);
    const confidence = hasPriceLabel && !specialPriceContext ? 'explicit' : 'ambiguous';
    candidates.push({
      start,
      end,
      raw,
      amountCop,
      kind,
      context,
      confidence,
      reason: confidence === 'explicit'
        ? 'Tiene etiqueta de precio cercana y no presenta contexto promocional conflictivo.'
        : 'El número parece un importe, pero requiere confirmación del operador.',
    });
  }

  const distinct = new Set(candidates.map((candidate) => candidate.amountCop));
  return {
    candidates,
    excluded,
    status: candidates.length === 0 ? 'no_price' : distinct.size > 1 ? 'ambiguous' : 'ready_for_review',
  };
}

export function extractShoeCode(text: string): { code: string | null; candidates: string[] } {
  CODE_LABEL.lastIndex = 0;
  const labeled = [...text.matchAll(CODE_LABEL)].map((match) => match[1]!).filter(Boolean);
  GENDER_CODE.lastIndex = 0;
  const implicit = [...text.matchAll(GENDER_CODE)].map((match) => match[1]!).filter(Boolean);
  const leading = text.match(LEADING_CODE);
  if (leading) {
    const code = leading[1]!;
    const codeStart = leading[0].indexOf(code);
    const remainder = text.slice(leading[0].length);
    // A reference before the product name is common (1059 *ADIDAS...). Do not
    // reinterpret a monetary amount, size or quantity as a shoe reference.
    const quantityOrPrice = /^(?:tallas?|sizes?|pares?|unidades?|docenas?|cajas?|mil|cop|pesos?|por|al|cm|us|eu|eur)\b/iu.test(remainder)
      || analyzePrices(text).candidates.some((candidate) => candidate.start <= codeStart && candidate.end >= codeStart + code.length);
    if (!quantityOrPrice) implicit.push(code);
  }
  const candidates = labeled.length > 0 ? labeled : implicit;
  const distinct = [...new Set(candidates.map((code) => code.toUpperCase()))];
  return { code: distinct.length === 1 ? candidates[0]! : null, candidates: distinct };
}

export function priceReplacement(candidate: PriceCandidate, amountCop: number): string {
  const raw = candidate.raw.trim();
  const amount = formatCop(amountCop);
  if (/^💲/.test(raw)) return `💲${amount.slice(1)}`;
  if (/^COP\b/i.test(raw)) return `COP ${amount.slice(1)}`;
  return amount;
}

export function formatCop(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('El valor COP debe ser un entero no negativo.');
  return `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0, useGrouping: true }).format(amount)}`;
}

export function replacePriceRanges(text: string, ranges: Array<{ start: number; end: number }>, replacement: string): string {
  const ordered = [...ranges].sort((a, b) => b.start - a.start);
  let result = text;
  let previousStart = text.length + 1;
  for (const range of ordered) {
    if (range.start < 0 || range.end > text.length || range.start >= range.end || range.end > previousStart) {
      throw new RangeError('Los rangos de precio se solapan o están fuera del texto.');
    }
    result = result.slice(0, range.start) + replacement + result.slice(range.end);
    previousStart = range.start;
  }
  return result;
}

export function replacePriceCandidates(text: string, candidates: PriceCandidate[], amountsCop: number | number[]): string {
  if (Array.isArray(amountsCop) && amountsCop.length !== candidates.length) throw new RangeError('Debe indicarse un valor final por cada precio detectado.');
  const ranges = candidates.map((candidate, index) => ({ candidate, amountCop: Array.isArray(amountsCop) ? amountsCop[index]! : amountsCop }))
    .sort((a, b) => b.candidate.start - a.candidate.start);
  let result = text;
  for (const { candidate, amountCop } of ranges) {
    const nextCharacter = text[candidate.end] ?? '';
    const needsSeparator = /\p{L}/u.test(nextCharacter) && /\d\uFE0F?\u20E3/u.test(candidate.raw) && /^(?:COP|\$|💲)/iu.test(candidate.raw.trim());
    result = result.slice(0, candidate.start) + priceReplacement(candidate, amountCop) + (needsSeparator ? ' ' : '') + result.slice(candidate.end);
  }
  return result;
}

export function addMargin(sourcePriceCop: number, marginCop: number): number {
  if (!Number.isSafeInteger(sourcePriceCop) || sourcePriceCop <= 0) throw new RangeError('Precio de proveedor inválido.');
  if (!Number.isSafeInteger(marginCop) || marginCop < 0) throw new RangeError('Ganancia por proveedor inválida.');
  const final = sourcePriceCop + marginCop;
  if (!Number.isSafeInteger(final)) throw new RangeError('El precio final excede el rango permitido.');
  return final;
}
