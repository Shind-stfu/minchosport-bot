import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import type { OverlayPosition } from '@tenis/core';

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const EMOJI_FILES: Record<string, string> = {
  '🌎': '1f30e.png', '🌍': '1f30d.png', '🌏': '1f30f.png', '🌐': '1f310.png', '⭐': '2b50.png',
};
const PIXEL_LIMIT = 40_000_000;
const OUTPUT_LIMIT = 20 * 1024 * 1024;
const RENDER_VERSION = 'native-emoji-gender-aliases-20261024';
const APPLE_TEXT_FONT = '/System/Library/Fonts/SFNS.ttf';
const APPLE_EMOJI_FONT = '/System/Library/Fonts/Apple Color Emoji.ttc';
const WINDOWS_TEXT_FONT = 'C:/Windows/Fonts/segoeuib.ttf';
const WINDOWS_EMOJI_FONT = 'C:/Windows/Fonts/seguiemj.ttf';
const positions: Record<OverlayPosition, { horizontal: 'left' | 'right'; vertical: 'top' | 'bottom' }> = {
  top_left: { horizontal: 'left', vertical: 'top' },
  top_right: { horizontal: 'right', vertical: 'top' },
  bottom_left: { horizontal: 'left', vertical: 'bottom' },
  bottom_right: { horizontal: 'right', vertical: 'bottom' },
};

function markerParts(marker: string): Array<{ text: string } | { emoji: string }> {
  const result: Array<{ text: string } | { emoji: string }> = [];
  let text = '';
  for (const character of marker) {
    if (character === '\uFE0F') continue;
    if (EMOJI_FILES[character]) {
      if (text) result.push({ text }), text = '';
      result.push({ emoji: character });
    } else text += character;
  }
  if (text) result.push({ text });
  return result;
}

async function textTile(text: string, fontSize: number) {
  const options = { text, width: Math.max(1, Math.ceil(text.length * fontSize * 1.1)), rgba: true, dpi: 72 };
  const native = process.platform === 'darwin' && existsSync(APPLE_TEXT_FONT)
    ? { font: `SF Pro Display Bold ${fontSize}px`, fontfile: APPLE_TEXT_FONT }
    : process.platform === 'win32' && existsSync(WINDOWS_TEXT_FONT)
      ? { font: `Segoe UI Bold ${fontSize}px`, fontfile: WINDOWS_TEXT_FONT }
      : undefined;
  let tile;
  try {
    tile = await sharp({ text: { ...options, ...native, ...(!native ? { font: `Noto Sans Bold ${fontSize}px`, fontfile: join(ASSET_ROOT, 'fonts', 'NotoSans.ttf') } : {}) } }).png().toBuffer({ resolveWithObject: true });
  } catch {
    tile = await sharp({ text: { ...options, font: `Noto Sans Bold ${fontSize}px`, fontfile: join(ASSET_ROOT, 'fonts', 'NotoSans.ttf') } }).png().toBuffer({ resolveWithObject: true });
  }
  return { input: tile.data, width: tile.info.width, height: tile.info.height };
}

export function hasNativeEmojiRenderer() {
  return (process.platform === 'darwin' && existsSync(APPLE_EMOJI_FONT))
    || (process.platform === 'win32' && existsSync(WINDOWS_EMOJI_FONT));
}

export function genderIndicatorFromDescription(description: string): 'H' | 'D' | null {
  const normalized = description.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  const hasMale = /(?:^|[^\p{L}])(?:HOMBRES?|CABALLEROS?|VARON(?:ES)?)(?=$|[^\p{L}])/u.test(normalized)
    || /(?:^|[^\p{L}\p{N}_-])H(?=$|[^\p{L}\p{N}_-])/u.test(normalized);
  const hasFemale = /(?:^|[^\p{L}])(?:MUJER(?:ES)?|DAMAS?)(?=$|[^\p{L}])/u.test(normalized)
    || /(?:^|[^\p{L}\p{N}_-])D(?=$|[^\p{L}\p{N}_-])/u.test(normalized);
  if (hasMale === hasFemale) return null;
  return hasMale ? 'H' : 'D';
}

export async function renderEmojiGraphic(emoji: string, size: number, style: 'native' | 'twemoji' = 'native'): Promise<Buffer> {
  const fileName = EMOJI_FILES[emoji];
  if (!fileName) throw new Error(`No hay un gráfico incluido para ${emoji}.`);
  if (style === 'native') {
    const native = process.platform === 'darwin' && existsSync(APPLE_EMOJI_FONT)
      ? { font: `Apple Color Emoji ${size}px`, fontfile: APPLE_EMOJI_FONT }
      : process.platform === 'win32' && existsSync(WINDOWS_EMOJI_FONT)
        ? { font: `Segoe UI Emoji ${size}px`, fontfile: WINDOWS_EMOJI_FONT }
        : undefined;
    if (native) {
      try {
        const rendered = await sharp({ text: { text: emoji, ...native, width: size, rgba: true, dpi: 72 } }).png().toBuffer();
        return sharp(rendered).resize(size, size, { fit: 'contain' }).png().toBuffer();
      } catch { /* use the bundled emoji artwork on systems where native color fonts cannot render */ }
    }
  }
  return sharp(join(ASSET_ROOT, 'emoji', fileName)).resize(size, size, { fit: 'contain' }).png().toBuffer();
}

async function emojiTile(emoji: string, size: number) {
  const input = await renderEmojiGraphic(emoji, size, 'native');
  const info = await sharp(input).metadata();
  return { input, width: info.width ?? size, height: info.height ?? size };
}

export async function renderMarkedImage(source: Buffer, options: { code: string | null; marker: string; position: OverlayPosition; genderIndicator?: 'H' | 'D' | null; sourceCode?: string | null; sourceHasWorld?: boolean }): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!/^[\s.\-🌎🌍🌏🌐⭐\uFE0F]+$/u.test(options.marker) || !/[🌎🌍🌏🌐]/u.test(options.marker)) {
    throw new Error('La marca debe contener un emoji de mundo, con punto, guion o estrella opcionales.');
  }
  const requestedCode = options.code?.trim() ?? '';
  const sourceCode = options.sourceCode?.trim() ?? '';
  const code = requestedCode && sourceCode.toUpperCase() !== requestedCode.toUpperCase() ? requestedCode : '';
  if (code && !/^[\p{L}\p{N}-]{1,32}$/u.test(code)) throw new Error('El código debe contener hasta 32 letras, números o guiones.');

  const oriented = await sharp(source, { limitInputPixels: PIXEL_LIMIT, autoOrient: true, failOn: 'warning' }).toBuffer({ resolveWithObject: true });
  const { width, height, format } = oriented.info;
  if (!width || !height || width < 16 || height < 16) throw new Error('La fotografía es demasiado pequeña para añadir una marca visible.');
  if (!code && options.sourceHasWorld) {
    return { bytes: source, mimeType: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : format === 'gif' ? 'image/gif' : 'image/jpeg' };
  }
  const shortSide = Math.min(width, height);
  const fontSize = Math.max(12, Math.min(56, Math.round(shortSide * 0.056)));
  const iconSize = Math.round(fontSize * 1.12);
  const gap = Math.max(3, Math.round(fontSize * 0.18));
  const padding = Math.max(5, Math.round(fontSize * 0.42));
  const parts: Array<{ input: Buffer; width: number; height: number }> = [];

  // Numeric supplier labels can already include the same H/D suffix.
  const indicator = options.genderIndicator ?? '';
  const hasIndicator = indicator && /^\d{3,6}(?:-\d{1,4})?[HD]$/iu.test(code) && code.toUpperCase().endsWith(indicator);
  if (code) parts.push(await textTile(`${code}${hasIndicator ? '' : indicator}`, fontSize));
  for (const part of options.sourceHasWorld ? [] : markerParts(options.marker)) {
    if ('text' in part) {
      if (part.text) parts.push(await textTile(part.text, fontSize));
    } else {
      parts.push(await emojiTile(part.emoji, iconSize));
    }
  }
  const contentWidth = parts.reduce((sum, part) => sum + part.width, 0) + Math.max(0, parts.length - 1) * gap;
  const contentHeight = Math.max(...parts.map((part) => part.height));
  const labelWidth = contentWidth + padding * 2;
  const labelHeight = contentHeight + padding * 2;
  if (labelWidth > width * 0.48 || labelHeight > height * 0.3) throw new Error('La foto es muy pequeña para mostrar el código y la marca sin tapar demasiado producto.');

  const background = Buffer.from(`<svg width="${labelWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect x="0.5" y="0.5" width="${labelWidth - 1}" height="${labelHeight - 1}" rx="${Math.round(padding * 0.65)}" fill="#ffffff" fill-opacity="1"/></svg>`);
  const layers: OverlayOptions[] = [{ input: background, left: 0, top: 0 }];
  let left = padding;
  for (const part of parts) {
    layers.push({ input: part.input, left, top: padding + Math.floor((contentHeight - part.height) / 2) });
    left += part.width + gap;
  }
  const horizontalMargin = Math.max(12, Math.round(width * 0.045));
  const corner = positions[options.position];
  const verticalMargin = Math.max(16, Math.round(height * (corner.vertical === 'top' ? 0.12 : 0.08)));
  const x = corner.horizontal === 'left' ? horizontalMargin : width - labelWidth - horizontalMargin;
  const y = corner.vertical === 'top' ? verticalMargin : height - labelHeight - verticalMargin;
  const output = await sharp(oriented.data, { limitInputPixels: PIXEL_LIMIT }).composite([{ input: await sharp({ create: { width: labelWidth, height: labelHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer(), left: x, top: y }])
    .toFormat(format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpeg', { quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (output.data.length > OUTPUT_LIMIT) throw new Error('La foto marcada supera el límite de 20 MiB.');
  return { bytes: output.data, mimeType: output.info.format === 'png' ? 'image/png' : output.info.format === 'webp' ? 'image/webp' : 'image/jpeg' };
}

export async function saveMarkedImage(dataDirectory: string, source: Buffer, identity: string, options: { code: string | null; marker: string; position: OverlayPosition; genderIndicator?: 'H' | 'D' | null; sourceCode?: string | null; sourceHasWorld?: boolean }) {
  const digest = createHash('sha256').update(RENDER_VERSION).update(process.platform).update(identity).update(JSON.stringify(options)).digest('hex');
  const directory = join(dataDirectory, 'media', 'derived');
  mkdirSync(directory, { recursive: true });
  for (const extension of ['jpg', 'png', 'webp', 'gif']) {
    const existing = join(directory, `${digest}.${extension}`);
    if (existsSync(existing)) return { fileName: `${digest}.${extension}`, mimeType: extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg', path: existing };
  }
  const rendered = await renderMarkedImage(source, options);
  const extension = rendered.mimeType === 'image/png' ? 'png' : rendered.mimeType === 'image/webp' ? 'webp' : rendered.mimeType === 'image/gif' ? 'gif' : 'jpg';
  const fileName = `${digest}.${extension}`;
  const path = join(directory, fileName);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  writeFileSync(temporary, rendered.bytes, { flag: 'wx' });
  try { renameSync(temporary, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    rmSync(temporary, { force: true });
  }
  return { fileName, mimeType: rendered.mimeType, path };
}
