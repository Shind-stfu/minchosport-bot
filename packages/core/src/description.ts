function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function descriptionContainsBrand(text: string, brand: string) {
  const words = brand.trim().replace(/\s+/gu, ' ');
  if (!words) return false;
  const pattern = words.split(' ').map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Adds a detected brand to the code line of an editable product caption. */
export function prependBrandBeforeShoeCode(text: string, brand: string, shoeCode?: string | null) {
  const cleanBrand = brand.trim().replace(/\s+/gu, ' ');
  if (!cleanBrand || !text.trim()) return text;

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
  const codeMatch = (codeLineIndex >= 0 ? codePattern : referencePattern).exec(targetLine);
  const textBeforeCode = codeMatch ? targetLine.slice(0, codeMatch.index) : '';
  if (descriptionContainsBrand(textBeforeCode, cleanBrand)) return text;
  lines[targetLineIndex] = `${cleanBrand} ${targetLine.trimStart()}`;
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}
