import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { analyzePrices } from '@tenis/core';
import { hasNativeEmojiRenderer, renderEmojiGraphic } from './image-marking.js';
import type { CornerLabel } from './image-marking-decision.js';
import { IMAGE_ENGINE_VERSION } from './image-engine.js';

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
const WORLD_EMOJIS = new Map([
  ['🌎', '1f30e.png'], ['🌍', '1f30d.png'], ['🌏', '1f30f.png'], ['🌐', '1f310.png'],
]);
const MAX_IMAGE_PIXELS = 40_000_000;
const WORLD_TEMPLATE_SIZES = [6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64];
const WORLD_MATCH_ERROR = 0.14;
const TWEMOJI_MATCH_CONFIDENCE = 0.72;
const NATIVE_MATCH_CONFIDENCE = 0.68;

export type ImageCodeCandidate = { code: string; confidence: number; evidence: 'label' | 'mixed-code' | 'number-only' };
export type WorldMarkDetection = { detected: boolean; variant: string | null; confidence: number; bounds: { left: number; top: number; width: number; height: number } | null };
export type ImageInspection = {
  ocrText: string;
  ocrConfidence: number;
  ocrError: string | null;
  codeCandidates: ImageCodeCandidate[];
  detectedCode: string | null;
  detectedCodeConfidence: number;
  world: WorldMarkDetection;
  regions?: CornerLabel[];
  metrics?: { durationMs: number; ocrPasses: number };
};

type LabelReading = { text: string; confidence: number };
export function resolveCornerCode(wide: LabelReading, focused: LabelReading, isolatedFromWorld = false) {
  const readings = [wide, focused].map((reading) => ({ ...reading, code: codeOnCornerLabel(reading.text) }));
  const [broad, narrow] = readings as [typeof readings[number], typeof readings[number]];
  const canonical = (code: string) => code.replace(/\s+[A-Z]$/u, '').replace(/\s/gu, '');
  // The broad OCR sometimes reads the globe as an extra 8/9. Only trust a
  // physically isolated text crop to resolve that specific disagreement.
  if (isolatedFromWorld && narrow.code && narrow.confidence >= 70 && (!broad.code
    || canonical(broad.code) === canonical(narrow.code)
    || new RegExp(`^${canonical(narrow.code).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[0-9OQBG]{1,2}$`, 'u').test(canonical(broad.code)))) {
    return { code: narrow.code, text: narrow.text, confidence: narrow.confidence, codeUncertain: false };
  }
  const codes = readings.filter((reading) => reading.code);
  const conflict = new Set(codes.map((reading) => canonical(reading.code!))).size > 1;
  const best = codes.sort((a, b) => b.confidence - a.confidence)[0];
  return { code: !conflict && best && best.confidence >= 55 ? best.code : null,
    text: best?.text ?? focused.text, confidence: best?.confidence ?? 0, codeUncertain: conflict || Boolean(best && best.confidence < 55) };
}

const CORNERS: CornerLabel['corner'][] = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];

export function codeOnCornerLabel(text: string): string | null {
  const normalized = text.toUpperCase().replace(/[|]/gu, 'I').replace(/\s+/gu, ' ').trim();
  const explicit = normalized.match(/\b(?:COD(?:IGO)?|C[ÓO]DIGO|REF(?:ERENCIA)?|SKU)\s*[:#.-]?\s*([A-Z0-9][A-Z0-9-]{1,31})(?:\s+([A-Z]))?\b/u);
  if (explicit) return `${explicit[1]}${explicit[2] ? ` ${explicit[2]}` : ''}`;
  if (/\b(?:PRECIO|CAJA|DOCENA|TALLAS?|SIZES?|EUR|US|COP|PARES?)\b|[$💲]/u.test(normalized)) return null;
  if (/\b\d{1,3}(?:[.,]\d{3})+\b/u.test(normalized)) return null;
  // Long OCR passages are usually product/background noise, not a compact label.
  if (normalized.length > 120) return null;
  const bare = normalized.match(/(?:^|[^\p{L}\p{N}])(\d{3,6}(?:-\d{1,4})?)(?:\s*([A-Z]))?(?=\s|$|[🌎🌍🌏🌐):,;!?])/u);
  return bare ? `${bare[1]}${bare[2] ? ` ${bare[2]}` : ''}` : null;
}

function coloredGlobeLocation(data: Buffer, width: number, height: number, channels: number): { status: 'detected' | 'uncertain' | 'none'; bounds?: { left: number; top: number; width: number; height: number } } {
  // A colored globe on a pale label can be recognized when exact emoji templates differ.
  const step = Math.max(1, Math.floor(Math.min(width, height) / 160));
  const cells = new Map<string, { blue: number; green: number; minX: number; minY: number; maxX: number; maxY: number }>();
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const offset = (y * width + x) * channels;
    const r = data[offset] ?? 0, g = data[offset + 1] ?? 0, b = data[offset + 2] ?? 0;
    const blue = b > 110 && b > r * 1.28 && b > g * 1.08;
    const green = g > 85 && g > r * 1.23 && g > b * 0.72;
    if (!blue && !green) continue;
    const key = `${Math.floor(x / 36)}:${Math.floor(y / 36)}`;
    const cell = cells.get(key) ?? { blue: 0, green: 0, minX: x, minY: y, maxX: x, maxY: y };
    if (blue) cell.blue += 1; else cell.green += 1;
    cell.minX = Math.min(cell.minX, x); cell.minY = Math.min(cell.minY, y);
    cell.maxX = Math.max(cell.maxX, x); cell.maxY = Math.max(cell.maxY, y);
    cells.set(key, cell);
  }
  let uncertain = false;
  for (const cell of cells.values()) {
    if (cell.blue < 3 || cell.green < 3) continue;
    uncertain = true;
    let pale = 0, checked = 0;
    const pad = 20;
    for (let y = Math.max(0, cell.minY - pad); y <= Math.min(height - 1, cell.maxY + pad); y += step * 2) {
      for (let x = Math.max(0, cell.minX - pad); x <= Math.min(width - 1, cell.maxX + pad); x += step * 2) {
        const offset = (y * width + x) * channels;
        const r = data[offset] ?? 0, g = data[offset + 1] ?? 0, b = data[offset + 2] ?? 0;
        checked += 1;
        if (r > 190 && g > 190 && b > 190 && Math.max(r,g,b) - Math.min(r,g,b) < 40) pale += 1;
      }
    }
    if (checked >= 8 && cell.blue + cell.green >= 12 && pale / checked >= 0.35) {
      // The 36px sampling cells can split a small globe. Merge adjacent color
      // fragments before using its bounds to separate text from the emoji.
      let minX = cell.minX, minY = cell.minY, maxX = cell.maxX, maxY = cell.maxY;
      for (const neighbor of cells.values()) {
        if (neighbor.minX > maxX + 6 || neighbor.maxX < minX - 6 || neighbor.minY > maxY + 6 || neighbor.maxY < minY - 6) continue;
        if (Math.max(maxX, neighbor.maxX) - Math.min(minX, neighbor.minX) > 72 || Math.max(maxY, neighbor.maxY) - Math.min(minY, neighbor.minY) > 72) continue;
        minX = Math.min(minX, neighbor.minX); minY = Math.min(minY, neighbor.minY);
        maxX = Math.max(maxX, neighbor.maxX); maxY = Math.max(maxY, neighbor.maxY);
      }
      return { status: 'detected', bounds: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
    }
  }
  return { status: uncertain ? 'uncertain' : 'none' };
}

export function coloredGlobeInCorner(data: Buffer, width: number, height: number, channels: number): 'detected' | 'uncertain' | 'none' {
  return coloredGlobeLocation(data, width, height, channels).status;
}

type ColorSample = { x: number; y: number; r: number; g: number; b: number };
type WorldTemplate = { samples: ColorSample[] };
const templateCache = new Map<string, Promise<WorldTemplate>>();

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

function matchError(data: Buffer, width: number, channels: number, template: WorldTemplate, left: number, top: number) {
  let error = 0;
  let count = 0;
  for (const sample of template.samples) {
    const offset = ((top + sample.y) * width + left + sample.x) * channels;
    error += Math.abs((data[offset] ?? 0) - sample.r)
      + Math.abs((data[offset + 1] ?? 0) - sample.g)
      + Math.abs((data[offset + 2] ?? 0) - sample.b);
    count += 3;
    if (error / (count * 255) > WORLD_MATCH_ERROR) break;
  }
  return error / (count * 255);
}

function addCandidate(candidates: Map<string, ImageCodeCandidate>, candidate: ImageCodeCandidate) {
  const normalized = candidate.code.toUpperCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}-]{1,31}$/u.test(normalized)) return;
  const previous = candidates.get(normalized);
  if (!previous || candidate.confidence > previous.confidence) candidates.set(normalized, { ...candidate, code: normalized });
}

export function extractImageCodeCandidates(text: string, pageConfidence: number): { candidates: ImageCodeCandidate[]; detectedCode: string | null; detectedCodeConfidence: number } {
  const baseConfidence = clamp(pageConfidence / 100);
  const candidates = new Map<string, ImageCodeCandidate>();
  const labeled = /(?:^|[^\p{L}\p{N}])(?:COD(?:IGO)?|C[ÓO]DIGO|REF(?:ERENCIA)?|SKU)\s*[:#.-]?\s*([A-Z0-9][A-Z0-9-]{1,31})(?![\p{L}\p{N}])/giu;
  for (const match of text.matchAll(labeled)) {
    const code = match[1];
    if (code) addCandidate(candidates, { code, confidence: clamp(baseConfidence * 0.98), evidence: 'label' });
  }
  const genderLabeled = /(?:^|[^\p{L}\p{N}_])(?:HOMBRE|MUJER|DAMA|CABALLERO)(?:\s|[\p{Extended_Pictographic}\uFE0F\u200D\p{Emoji_Modifier}])+(\d{3}-\d{1,3})(?![\p{L}\p{N}_-])/giu;
  for (const match of text.matchAll(genderLabeled)) {
    const code = match[1];
    if (code) addCandidate(candidates, { code, confidence: clamp(baseConfidence * 0.9), evidence: 'label' });
  }

  const priceRanges = analyzePrices(text).candidates;
  const lines = text.split(/\r?\n/);
  let lineOffset = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const numberOnlyIsAmbiguous = /\b(?:tallas?|sizes?|eur|us|cm|precio|valor|cop|pares?|unidades?|hombre|mujer|dama|caballero)\b|[$💲]/iu.test(line);
    const mixedCode = /(?<![\p{L}\p{N}])[A-Z0-9]*[A-Z][A-Z0-9-]*\d[A-Z0-9-]*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d[A-Z0-9-]*[A-Z][A-Z0-9-]*(?![\p{L}\p{N}])/giu;
    for (const match of line.matchAll(mixedCode)) {
      const code = match[0];
      if (code) addCandidate(candidates, { code, confidence: clamp(baseConfidence * 0.72), evidence: 'mixed-code' });
    }
    if (!numberOnlyIsAmbiguous) {
      const numbers = /(?<![\p{L}\p{N}])\d{3,6}(?![\p{L}\p{N}])/gu;
      for (const match of line.matchAll(numbers)) {
        const start = (match.index ?? 0) + lineOffset;
        const end = start + match[0].length;
        if (priceRanges.some((range) => start < range.end && end > range.start)) continue;
        const amount = Number(match[0]);
        if (amount >= 20000) continue;
        addCandidate(candidates, { code: match[0], confidence: clamp(baseConfidence * 0.48), evidence: 'number-only' });
      }
    }
    const suffix = text.slice(lineOffset + line.length);
    const newlineWidth = lineIndex < lines.length - 1 ? (suffix.startsWith('\r\n') ? 2 : 1) : 0;
    lineOffset += line.length + newlineWidth;
  }

  const values = [...candidates.values()].sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code));
  const labeledValues = values.filter((candidate) => candidate.evidence === 'label');
  const uniqueLabeled = [...new Set(labeledValues.map((candidate) => candidate.code))];
  const selected = uniqueLabeled.length === 1 ? labeledValues.find((candidate) => candidate.code === uniqueLabeled[0]) : undefined;
  return { candidates: values, detectedCode: selected?.code ?? null, detectedCodeConfidence: selected?.confidence ?? 0 };
}

async function worldTemplate(emoji: string, size: number, style: 'native' | 'twemoji'): Promise<WorldTemplate> {
  const fileName = WORLD_EMOJIS.get(emoji);
  if (!fileName) throw new Error(`No hay una plantilla visual para ${emoji}.`);
  const key = `${emoji}:${size}:${style}`;
  let pending = templateCache.get(key);
  if (!pending) {
    const image = style === 'twemoji'
      ? sharp(join(ASSET_ROOT, 'emoji', fileName)).resize(size, size, { fit: 'contain' }).png().toBuffer()
      : renderEmojiGraphic(emoji, size, 'native');
    pending = image.then((buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
      .then(({ data, info }) => {
        const samples: ColorSample[] = [];
        const spacing = Math.max(1, Math.floor(size / 9));
        for (let y = 1; y < size - 1; y += spacing) for (let x = 1; x < size - 1; x += spacing) {
          const offset = (y * info.width + x) * info.channels;
          if ((data[offset + 3] ?? 0) < 220) continue;
          samples.push({ x, y, r: data[offset] ?? 0, g: data[offset + 1] ?? 0, b: data[offset + 2] ?? 0 });
        }
        return { samples };
      });
    templateCache.set(key, pending);
  }
  return pending;
}

export async function detectEmbeddedWorldMark(source: Buffer): Promise<WorldMarkDetection> {
  const image = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS, autoOrient: true, failOn: 'warning' })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = image.info;
  let best = { error: Number.POSITIVE_INFINITY, emoji: null as string | null, style: 'twemoji' as 'native' | 'twemoji', left: 0, top: 0, size: 0 };
  const styles: Array<'native' | 'twemoji'> = hasNativeEmojiRenderer() ? ['native', 'twemoji'] : ['twemoji'];
  for (const [emoji] of WORLD_EMOJIS) {
    for (const size of WORLD_TEMPLATE_SIZES) {
      for (const style of styles) {
        if (size > Math.min(width, height)) continue;
        const template = await worldTemplate(emoji, size, style);
        if (template.samples.length < 12) continue;
        const scanStep = size < 14 ? 1 : 3;
        for (let top = 0; top <= height - size; top += scanStep) {
          for (let left = 0; left <= width - size; left += scanStep) {
            const meanError = matchError(image.data, width, channels, template, left, top);
            if (meanError < best.error) best = { error: meanError, emoji, style, left, top, size };
          }
        }
      }
    }
  }
  if (best.emoji) {
    const template = await worldTemplate(best.emoji, best.size, best.style);
    for (let top = Math.max(0, best.top - 2); top <= Math.min(height - best.size, best.top + 2); top += 1) {
      for (let left = Math.max(0, best.left - 2); left <= Math.min(width - best.size, best.left + 2); left += 1) {
        const meanError = matchError(image.data, width, channels, template, left, top);
        if (meanError < best.error) best = { ...best, error: meanError, left, top };
      }
    }
  }
  const confidence = Number.isFinite(best.error) ? clamp(1 - best.error / WORLD_MATCH_ERROR) : 0;
  const threshold = hasNativeEmojiRenderer() ? NATIVE_MATCH_CONFIDENCE : TWEMOJI_MATCH_CONFIDENCE;
  const detected = Boolean(best.emoji && confidence >= threshold);
  return {
    detected,
    variant: detected ? best.emoji : null,
    confidence,
    bounds: detected ? { left: best.left, top: best.top, width: best.size, height: best.size } : null,
  };
}

export class LocalImageInspector {
  readonly version = IMAGE_ENGINE_VERSION;
  private workerPromise: Promise<Tesseract.Worker> | null = null;

  constructor(private readonly cachePath: string) {
    mkdirSync(cachePath, { recursive: true });
  }

  async inspect(source: Buffer): Promise<ImageInspection> {
    const started = performance.now();
    let ocrPasses = 0;
    const recognize = async (image: Buffer, psm = Tesseract.PSM.SINGLE_BLOCK) => {
      const worker = await this.getWorker();
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      ocrPasses += 1;
      return worker.recognize(image);
    };
    const oriented = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS, autoOrient: true, failOn: 'warning' }).toBuffer();
    const metadata = await sharp(oriented).metadata();
    const width = metadata.width ?? 0, height = metadata.height ?? 0;
    const normalized = await sharp(oriented)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).grayscale().normalize().sharpen().png().toBuffer();
    const [world, recognition] = await Promise.all([
      detectEmbeddedWorldMark(oriented),
      recognize(normalized).then((result) => ({ result })).catch((error: unknown) => ({ error })),
    ]);
    const ocrError = 'error' in recognition
      ? (recognition.error instanceof Error ? recognition.error.message.slice(0, 300) : 'No se pudo iniciar el OCR local.')
      : null;
    const data = 'result' in recognition ? recognition.result.data : null;
    const ocr = data ? extractImageCodeCandidates(data.text, data.confidence) : { candidates: [], detectedCode: null, detectedCodeConfidence: 0 };
    const regions: CornerLabel[] = [];
    if (!ocrError && width >= 32 && height >= 32) {
      const cornerWidth = Math.max(16, Math.floor(width * 0.55));
      const cornerHeight = Math.max(16, Math.floor(height * 0.34));
      for (const corner of CORNERS) {
        const left = corner.endsWith('left') ? 0 : width - cornerWidth;
        const top = corner.startsWith('top') ? 0 : height - cornerHeight;
        const crop = await sharp(oriented).extract({ left, top, width: cornerWidth, height: cornerHeight }).resize({ width: 1200, withoutEnlargement: true }).toBuffer();
        const ocrCrop = await sharp(crop).flatten({ background: '#ffffff' }).grayscale().normalize().sharpen().png().toBuffer();
        const result = await recognize(ocrCrop);
        const focusWidth = Math.max(16, Math.floor(width * 0.38));
        const focusHeight = Math.max(16, Math.floor(height * 0.22));
        const focusLeft = corner.endsWith('left') ? 0 : width - focusWidth;
        const focusTop = corner.startsWith('top') ? 0 : height - focusHeight;
        const raw = await sharp(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const colorLocation = coloredGlobeLocation(raw.data, raw.info.width, raw.info.height, raw.info.channels);
        const colorGlobe = colorLocation.status;
        const worldBounds = world.bounds;
        const worldScale = Math.min(512 / width, 512 / height, 1);
        const worldCenterX = worldBounds ? (worldBounds.left + worldBounds.width / 2) / worldScale : -1;
        const worldCenterY = worldBounds ? (worldBounds.top + worldBounds.height / 2) / worldScale : -1;
        const worldInCorner = world.detected && worldCenterX >= left && worldCenterX < left + cornerWidth && worldCenterY >= top && worldCenterY < top + cornerHeight;
        let focusedRegion = { left: focusLeft, top: focusTop, width: focusWidth, height: focusHeight };
        let isolated = false;
        const localScale = raw.info.width / cornerWidth;
        const location = worldInCorner && worldBounds ? { left: worldBounds.left / worldScale, top: worldBounds.top / worldScale, height: worldBounds.height / worldScale }
          : colorLocation.bounds ? { left: left + colorLocation.bounds.left / localScale, top: top + colorLocation.bounds.top / localScale, height: colorLocation.bounds.height / localScale } : null;
        if (location) {
          const worldLeft = Math.floor(location.left);
          const worldTop = Math.floor(location.top);
          const worldSize = Math.ceil(location.height);
          const textLeft = Math.max(left, worldLeft - Math.floor(width * 0.4));
          const textTop = Math.max(0, worldTop - Math.ceil(worldSize * 0.4));
          const textWidth = worldLeft - textLeft - 2;
          const textHeight = Math.min(height - textTop, Math.ceil(worldSize * 1.8));
          if (textWidth >= 24 && textHeight >= 16) {
            focusedRegion = { left: textLeft, top: textTop, width: textWidth, height: textHeight }; isolated = true;
          }
        }
        let focus = await sharp(oriented).extract(focusedRegion)
          .resize({ width: Math.min(1200, focusedRegion.width * 3) }).flatten({ background: '#ffffff' }).grayscale().threshold(220).png().toBuffer();
        if (isolated) focus = await sharp(focus).trim({ threshold: 10 }).extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff' }).png().toBuffer();
        const focused = (await recognize(focus, Tesseract.PSM.SINGLE_LINE)).data;
        const focusedText = focused.text.trim();
        const resolved = resolveCornerCode({ text: result.data.text.trim(), confidence: result.data.confidence }, { text: focusedText, confidence: focused.confidence }, isolated);
        const { code } = resolved;
        const hasWorld = worldInCorner || Boolean(code) && colorGlobe === 'detected';
        const ambiguousText = !code && /(?:^|[^\p{L}\p{N}])\d{3,6}(?:\s*[A-Z])?(?=\s|$)/u.test(focusedText);
        regions.push({ corner, text: resolved.text.slice(0, 500), code, codeConfidence: clamp(resolved.confidence / 100), codeUncertain: resolved.codeUncertain, hasWorld,
          worldUncertain: !hasWorld && (colorGlobe === 'detected' || Boolean(code) && colorGlobe === 'uncertain' || ambiguousText) });
      }
    }
    const candidates = new Map(ocr.candidates.map((candidate) => [candidate.code, candidate]));
    for (const region of regions) {
      if (region.code && !region.codeUncertain) addCandidate(candidates, { code: region.code.replace(/\s+[HD]$/u, '').replace(/\s/gu, ''), confidence: region.codeConfidence ?? 0, evidence: 'label' });
    }
    const codeCandidates = [...candidates.values()].sort((a, b) => b.confidence - a.confidence);
    const labeled = codeCandidates.filter((candidate) => candidate.evidence === 'label');
    const selected = labeled.length === 1 ? labeled[0] : undefined;
    return {
      ocrText: data?.text.trim().slice(0, 6000) ?? '',
      ocrConfidence: data ? clamp(data.confidence / 100) : 0,
      ocrError,
      codeCandidates,
      detectedCode: selected?.code ?? null,
      detectedCodeConfidence: selected?.confidence ?? 0,
      world: { ...world, detected: world.detected || regions.some((region) => region.hasWorld) },
      regions,
      metrics: { durationMs: Math.round(performance.now() - started), ocrPasses },
    };
  }

  async close(): Promise<void> {
    if (this.workerPromise) {
      const worker = await this.workerPromise.catch(() => null);
      this.workerPromise = null;
      if (worker) await worker.terminate();
    }
  }

  private getWorker(): Promise<Tesseract.Worker> {
    if (!this.workerPromise) {
      this.workerPromise = Tesseract.createWorker(['spa', 'eng'], 1, { cachePath: this.cachePath });
      this.workerPromise.catch(() => { this.workerPromise = null; });
    }
    return this.workerPromise;
  }
}
