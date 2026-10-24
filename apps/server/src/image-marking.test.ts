import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { genderIndicatorFromDescription, renderMarkedImage } from './image-marking.js';
import type { OverlayPosition } from '@tenis/core';

async function plainImage(width = 640, height = 480) {
  return sharp({ create: { width, height, channels: 3, background: { r: 32, g: 44, b: 36 } } }).png().toBuffer();
}

async function changedBounds(original: Buffer, result: Buffer) {
  const before = await sharp(original).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = after.info.width; let minY = after.info.height; let maxX = 0; let maxY = 0;
  for (let y = 0; y < after.info.height; y += 1) for (let x = 0; x < after.info.width; x += 1) {
    const offset = (y * after.info.width + x) * after.info.channels;
    if (before.data[offset] !== after.data[offset] || before.data[offset + 1] !== after.data[offset + 1] || before.data[offset + 2] !== after.data[offset + 2]) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

describe('marked product photography', () => {
  it.each([
    ['HOMBRE 106-5', 'H'],
    ['CABALLERO 123', 'H'],
    ['Mujer 015-81', 'D'],
    ['DAMA 954', 'D'],
    ['MUJERES 015-81', 'D'],
    ['1059 ADIDAS REPÓNSE DAMA $85.000 POR CAJA $70.000', 'D'],
    ['1059 ADIDAS mujer', 'D'],
    ['1059 ADIDAS D $70.000', 'D'],
    ['*d* 1059', 'D'],
    ['1059 (D)', 'D'],
    ['1059 H $70.000', 'H'],
    ['*h* 1059', 'H'],
    ['1059 Varón', 'H'],
    ['1059 varon', 'H'],
    ['1059 VARONES', 'H'],
    ['DAMA-1059', 'D'],
    ['HOMBRE-1059', 'H'],
    ['VARÓN-1059', 'H'],
  ] as const)('detects the gender indicator from "%s"', (description, expected) => {
    expect(genderIndicatorFromDescription(description)).toBe(expected);
  });

  it.each(['modelo DAMASCO 123', 'HOMBRERA 123', 'calzado unisex', 'HOMBRE Y DAMA', 'ADIDAS 1059', 'NIKE DH1234', 'COD H-123', 'SKU D-1059', '1059D', '1059H', 'UNISEX H/D', 'MUJER Y VARÓN'])('does not guess a gender for "%s"', (description) => {
    expect(genderIndicatorFromDescription(description)).toBeNull();
  });

  it('renders the gender indicator after the product code and before the provider world mark', async () => {
    const source = await plainImage();
    const withGender = await renderMarkedImage(source, { code: '123-16', genderIndicator: 'H', marker: '🌎', position: 'top_left' });
    const withoutGender = await renderMarkedImage(source, { code: '123-16', marker: '🌎', position: 'top_left' });
    expect(withGender.bytes.equals(withoutGender.bytes)).toBe(false);
  });

  it.each(['H', 'D'] as const)('does not duplicate an existing %s suffix on a numeric supplier code', async (indicator) => {
    const source = await plainImage();
    const expected = await renderMarkedImage(source, { code: `1059${indicator}`, marker: '🌎', position: 'bottom_right' });
    const appended = await renderMarkedImage(source, { code: '1059', genderIndicator: indicator, marker: '🌎', position: 'bottom_right' });
    const alreadyPresent = await renderMarkedImage(source, { code: `1059${indicator}`, genderIndicator: indicator, marker: '🌎', position: 'bottom_right' });
    expect(appended.bytes).toEqual(expected.bytes);
    expect(alreadyPresent.bytes).toEqual(expected.bytes);
  });

  it.each<OverlayPosition>(['top_left', 'top_right', 'bottom_left', 'bottom_right'])(
    'places the label in %s and preserves the source dimensions and bytes', async (position) => {
      const source = await plainImage();
      const original = Buffer.from(source);
      const output = await renderMarkedImage(source, { code: '001', marker: '🌎⭐', position });
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata).toMatchObject({ width: 640, height: 480, format: 'png' });
      expect(source).toEqual(original);
      const bounds = await changedBounds(original, output.bytes);
      expect(bounds.maxX - bounds.minX).toBeLessThan(640 * 0.5);
      expect(bounds.maxY - bounds.minY).toBeLessThan(480 * 0.3);
      expect(bounds.minX < 320).toBe(position.endsWith('left'));
      expect(bounds.minY < 240).toBe(position.startsWith('top'));
      expect(bounds.minX).toBeGreaterThan(position.endsWith('left') ? 640 * 0.02 : 640 * 0.68);
      expect(bounds.minX).toBeLessThan(position.endsWith('left') ? 640 * 0.12 : 640 * 0.95);
      expect(bounds.minY).toBeGreaterThan(position.startsWith('top') ? 480 * 0.08 : 480 * 0.72);
      expect(bounds.minY).toBeLessThan(position.startsWith('top') ? 480 * 0.25 : 480 * 0.9);
    },
    20_000,
  );

  it('uses a fully opaque white backing and a slightly larger label', async () => {
    const source = await plainImage();
    const result = await renderMarkedImage(source, { code: '001', marker: '🌎⭐', position: 'top_left' });
    const bounds = await changedBounds(source, result.bytes);
    const fontSize = Math.max(12, Math.min(56, Math.round(480 * 0.056)));
    const padding = Math.max(5, Math.round(fontSize * 0.42));
    const labelHeight = Math.max(Math.round(fontSize * 1.12), fontSize) + padding * 2;
    const pixel = await sharp(result.bytes)
      .extract({ left: 29 + Math.floor(padding / 2), top: 58 + Math.floor(labelHeight / 2), width: 1, height: 1 })
      .removeAlpha().raw().toBuffer();

    expect([...pixel]).toEqual([255, 255, 255]);
    expect(bounds.maxX - bounds.minX + 1).toBeGreaterThan(130);
    expect(bounds.maxY - bounds.minY + 1).toBeGreaterThan(50);
  });

  it.each(['🌎', '🌎.', '- 🌎⭐', '🌍⭐', '🌏⭐', '🌐⭐'])('renders provider mark %s without a code', async (marker) => {
    const source = await plainImage(360, 640);
    const result = await renderMarkedImage(source, { code: null, marker, position: 'bottom_right' });
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 360, height: 640 });
    expect(result.mimeType).toBe('image/png');
  });

  it('normalizes EXIF rotation before marking a portrait photograph', async () => {
    const source = await sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 32, g: 44, b: 36 } } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await renderMarkedImage(source, { code: 'AB-7', marker: '🌎⭐', position: 'bottom_right' });
    expect(await sharp(source).metadata()).toMatchObject({ width: 300, height: 500, orientation: 6 });
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 500, height: 300 });
  });

  it('rejects bad markers and codes instead of allowing a send with a missing overlay', async () => {
    const source = await plainImage();
    await expect(renderMarkedImage(source, { code: null, marker: '⭐', position: 'bottom_right' })).rejects.toThrow('mundo');
    await expect(renderMarkedImage(source, { code: 'COD 123', marker: '🌎', position: 'bottom_right' })).rejects.toThrow('código');
  });
});

describe('avoiding duplicate marks detected in the source photograph', () => {
  it('returns the original bytes when both the selected code and a world mark are already present', async () => {
    const original = await plainImage();
    const result = await renderMarkedImage(original, { code: '001', sourceCode: '001', marker: '🌎⭐', sourceHasWorld: true, position: 'bottom_right' });
    expect(result.bytes).toEqual(original);
  });

  it('adds the code but suppresses the configured world mark if one is already in the photo', async () => {
    const original = await plainImage();
    const withoutDuplicate = await renderMarkedImage(original, { code: '001', marker: '🌎⭐', sourceHasWorld: true, position: 'bottom_right' });
    const withDuplicate = await renderMarkedImage(original, { code: '001', marker: '🌎⭐', position: 'bottom_right' });
    expect(withoutDuplicate.bytes.equals(original)).toBe(false);
    expect(withoutDuplicate.bytes.equals(withDuplicate.bytes)).toBe(false);
  });

  it('adds the configured world mark but suppresses a matching code already in the photo', async () => {
    const original = await plainImage();
    const withoutDuplicate = await renderMarkedImage(original, { code: '001', sourceCode: '001', marker: '🌎⭐', position: 'bottom_right' });
    const withDuplicate = await renderMarkedImage(original, { code: '001', marker: '🌎⭐', position: 'bottom_right' });
    const markerOnly = await renderMarkedImage(original, { code: null, marker: '🌎⭐', position: 'bottom_right' });
    expect(withoutDuplicate.bytes.equals(withDuplicate.bytes)).toBe(false);
    expect(withoutDuplicate.bytes).toEqual(markerOnly.bytes);
  });
});
