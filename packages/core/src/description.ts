function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function descriptionContainsBrand(text: string, brand: string) {
  const words = brand.trim().replace(/\s+/gu, ' ');
  if (!words) return false;
  const pattern = words.split(' ').map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function brandNameVariants(brand: string, aliases: readonly string[]) {
  const variants = new Set([brand, ...aliases].map((value) => value.trim().replace(/\s+/gu, ' ')).filter(Boolean));
  // Brand prefixes with at least two words catch shortened supplier names such
  // as "LE COQ" when the canonical brand is "LE COQ SPORTIF". Single words
  // are deliberately excluded because they are often ordinary title words.
  const words = brand.split(/\s+/u).filter(Boolean);
  for (let length = 2; length < words.length; length += 1) variants.add(words.slice(0, length).join(' '));
  return [...variants].sort((left, right) => right.length - left.length);
}

/** Adds a detected brand to the code line and removes duplicate brand aliases from that line. */
export function prependBrandBeforeShoeCode(text: string, brand: string, shoeCode?: string | null, aliases: readonly string[] = []) {
  const cleanBrand = brand.trim().replace(/\s+/gu, ' ');
  if (!cleanBrand || !text.trim()) return text;
  const brandAlreadyPresent = descriptionContainsBrand(text, cleanBrand);

  const lines = text.split(/\r?\n/u);
  const code = shoeCode?.trim();
  const codePattern = code
    ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(code)}(?![\\p{L}\\p{N}_-])`, 'iu')
    : /(?:^|[^\p{L}\p{N}_])(?:COD(?:IGO)?|C[ÓO]DIGO|REF(?:ERENCIA)?|SKU)\s*[:#.-]?\s*[A-Z0-9][A-Z0-9-]{0,31}(?![\p{L}\p{N}_])/iu;
  const referencePattern = /(?:^|[^\p{L}\p{N}_])(?:COD(?:IGO)?|C[ÓO]DIGO|REF(?:ERENCIA)?|SKU)\s*[:#.-]?\s*[A-Z0-9][A-Z0-9 -]{0,31}/iu;
  const codeLineIndex = lines.findIndex((line) => codePattern.test(line));
  const referenceLineIndex = lines.findIndex((line) => referencePattern.test(line));
  const targetLineIndex = codeLineIndex >= 0 ? codeLineIndex : referenceLineIndex;
  if (targetLineIndex < 0) return text;
  const targetLine = lines[targetLineIndex] ?? '';
  const canonicalKey = cleanBrand.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('es');
  const duplicateVariants = brandNameVariants(cleanBrand, aliases).filter((variant) =>
    variant.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('es') !== canonicalKey);
  const canonicalPattern = new RegExp(`(?<![\\p{L}\\p{N}])${cleanBrand.split(/\s+/u).map(escapeRegExp).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  const deduplicatedLine = duplicateVariants.reduce((line, variant) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${variant.split(/\s+/u).map(escapeRegExp).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    const protectedCanonicalRanges = brandAlreadyPresent
      ? [...line.matchAll(canonicalPattern)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const)
      : [];
    return line.replace(pattern, (match, offset: number) => protectedCanonicalRanges.some(([start, end]) => start <= offset && end >= offset + match.length) ? match : ' ')
      .replace(/\s{2,}/gu, ' ');
  }, targetLine).replace(/\s+([,;:])/gu, '$1').trim();
  if (brandAlreadyPresent) {
    if (deduplicatedLine === targetLine) return text;
    lines[targetLineIndex] = deduplicatedLine;
  } else {
    lines[targetLineIndex] = `${cleanBrand} ${deduplicatedLine}`.trimEnd();
  }
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}
