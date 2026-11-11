const NON_BRANDS = new Set(`COD CODIGO REF REFERENCIA SKU PRECIO CAJA DOCENA TALLA TALLAS SIZE SIZES EUR EURO COP USD HOMBRE HOMBRES MUJER MUJERES DAMA DAMAS CABALLERO CABALLEROS NINO NINOS NINA NINAS TENIS ZAPATO ZAPATOS SNEAKER SNEAKERS SHOES SHOE NUEVO NUEVA ORIGINAL IMPORTADO IMPORTADA DISPONIBLE VENTA MARCA BRAND MODELO MODEL PUBLICACION WHATSAPP SUPER STAR CAMBIO GARANTIA PROMO ULTIMA RETRO BUENAS BUENOS TARDES DIAS NOCHES INFORMAMOS INFORMACION DEVOLUCIONES RECIBIDAS RECIBIDOS HASTA HOY DIA PERSONA INGRESAR CUADRAR PEDIMOS SER CUMPLIDOS HORARIOS SE LES QUE LAS DEL POR PARA CON UNA UNOS UNAS ESTOS ESTAS ESTE ESTA LOS LAS Y O A DE EN`.split(' '));

export function normalizeBrandName(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('es').replace(/[^\p{L}\p{N}&.' -]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Detect a shoe-specific Jordan mark even when the model labels the shoe as Nike or no brand. */
export function detectJordanBrandSignal(texts: Array<string | null | undefined>): 'jumpman' | 'jordan' | null {
  const text = texts.filter((value): value is string => Boolean(value)).join(' ');
  if (/\b(?:jumodman|jumdman|jump\s*man)\b/iu.test(text)) return 'jumpman';
  // Florence/Qwen sometimes hallucinates "AIRBAN" when describing the Air Jordan
  // wings logo. Treat that model output as a Jordan signal before it can be saved
  // as an unrelated open-vocabulary brand.
  if (/\b(?:air\s*ban|airban|(?:air\s+)?jordan)\b/iu.test(text)) return 'jordan';
  return null;
}

/** Recover a clear brand consensus from repeated Florence/Qwen JSON crop responses. */
export function resolveVisionBrandConsensus(answer: string, logoText = '') {
  const votes: string[] = [];
  for (const match of answer.matchAll(/\{[^{}]*\}/gu)) {
    try {
      const parsed = JSON.parse(match[0]) as { brand?: unknown; uncertain?: unknown };
      if (parsed.uncertain === true || typeof parsed.brand !== 'string') continue;
      const brand = parsed.brand.trim();
      if (!brand || /^(?:null|none|unknown|unclear)$/iu.test(brand)) continue;
      votes.push(brand);
    } catch { /* Ignore malformed crop responses and keep the other votes. */ }
  }
  const byBrand = new Map<string, { brand: string; count: number }>();
  for (const brand of votes) {
    const normalized = normalizeBrandName(brand);
    if (!normalized) continue;
    const current = byBrand.get(normalized);
    byBrand.set(normalized, { brand: current?.brand ?? brand, count: (current?.count ?? 0) + 1 });
  }
  const ranked = [...byBrand.values()].sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand, 'es'));
  const winner = ranked[0];
  const totalVotes = votes.length;
  if (!winner || winner.count < 2 || totalVotes === 0) return { brand: null, votes: winner?.count ?? 0, totalVotes, disagreement: false, confidence: 0 };
  const share = winner.count / totalVotes;
  const normalizedLogoText = ` ${normalizeBrandName(logoText)} `;
  const logoSupportsWinner = normalizedLogoText.includes(` ${normalizeBrandName(winner.brand)} `);
  const qualifies = share >= 0.75 || share >= 2 / 3 && logoSupportsWinner;
  if (!qualifies) return { brand: null, votes: winner.count, totalVotes, disagreement: ranked.length > 1, confidence: 0 };
  return {
    brand: winner.brand,
    votes: winner.count,
    totalVotes,
    disagreement: winner.count < totalVotes,
    confidence: winner.count === totalVotes ? logoSupportsWinner ? 0.92 : 0.82 : logoSupportsWinner ? 0.82 : 0.72,
  };
}

export function extractBrandCandidates(text: string, knownBrands: string[] = [], options: { allowLowercaseWords?: boolean } = {}) {
  const normalizedText = text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
  const candidates = new Map<string, string>();
  const add = (candidate: string) => {
    const cleaned = candidate.replace(/[^\p{L}\p{N}&.' -]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const normalized = normalizeBrandName(cleaned);
    const words = cleaned.split(' ').filter(Boolean);
    if (normalized.length < 2 || normalized.length > 40 || words.length > 4 || words.some((word) => NON_BRANDS.has(word.toLocaleUpperCase('es')))) return;
    candidates.set(normalized, cleaned);
  };

  for (const brand of knownBrands) add(brand);
  // Captions and OCR often present brands in uppercase (NIKE) or title case
  // (New Balance). Candidate extraction is open vocabulary; the image model
  // decides whether each phrase actually describes the shoe brand.
  const pattern = /\b[\p{Lu}][\p{L}\p{N}&.'-]*(?:\s+[\p{Lu}][\p{L}\p{N}&.'-]*){0,3}\b/gu;
  for (const match of normalizedText.matchAll(pattern)) {
    const words = match[0].split(/\s+/u);
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start + 1; end <= Math.min(words.length, start + 4); end += 1) add(words.slice(start, end).join(' '));
    }
  }
  const explicitBrand = /\b(?:marca|brand)\s*(?:es\s*)?[:=-]?\s*([^\n,;.!]{2,48})/iu.exec(text);
  if (explicitBrand?.[1]) add(explicitBrand[1]);
  if (options.allowLowercaseWords) {
    const lowercaseWords = /\b[\p{Ll}][\p{L}\p{N}&.'-]{2,}\b/gu;
    for (const match of text.matchAll(lowercaseWords)) add(match[0]);
  }
  return [...candidates.values()].slice(0, 64);
}

/** Learns extra candidate names from repeated product titles, without a fixed brand catalogue. */
export function extractCatalogBrandCandidates(titles: string[], knownBrands: string[] = [], limit = 32) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const title of titles) {
    const seen = new Set<string>();
    for (const name of extractBrandCandidates(title)) {
      const normalized = normalizeBrandName(name);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const current = counts.get(normalized);
      counts.set(normalized, { name: current?.name ?? name, count: (current?.count ?? 0) + 1 });
    }
  }
  const learned = [...counts.entries()]
    .filter(([normalized, value]) => value.count >= 2 && !knownBrands.some((brand) => normalizeBrandName(brand) === normalized))
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'es'))
    .slice(0, Math.max(0, Math.min(64, limit)))
    .map(([, value]) => value.name);
  return [...new Set([...knownBrands, ...learned])];
}
