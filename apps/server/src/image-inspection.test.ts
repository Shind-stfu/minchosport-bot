import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { codeOnCornerLabel, coloredGlobeInCorner, detectEmbeddedWorldMark, extractImageCodeCandidates, resolveCornerCode } from './image-inspection.js';
import { hasNativeEmojiRenderer, renderEmojiGraphic } from './image-marking.js';

describe('inspección local de fotografías', () => {
  it('requires agreement and sufficient OCR confidence, and only resolves extra globe digits from an isolated text crop', () => {
    const reading = (text: string, confidence = 90) => ({ text, confidence });
    expect(resolveCornerCode(reading('096-2158'), reading('096-215'), true)).toMatchObject({ code: '096-215', codeUncertain: false });
    expect(resolveCornerCode(reading('096-2158'), reading('096-215'), false)).toMatchObject({ code: null, codeUncertain: true });
    expect(resolveCornerCode(reading('960'), reading('999'), true)).toMatchObject({ code: null, codeUncertain: true });
    expect(resolveCornerCode(reading('COD 001', 20), reading('001', 30))).toMatchObject({ code: null, codeUncertain: true });
    expect(resolveCornerCode(reading('960'), reading('960 H'))).toMatchObject({ code: '960', codeUncertain: false });
    expect(resolveCornerCode(reading('PRECIO $60.000'), reading('TALLAS 38-42'))).toMatchObject({ code: null, codeUncertain: false });
    expect(codeOnCornerLabel('096-215:')).toBe('096-215');
    expect(codeOnCornerLabel('60.000')).toBeNull();
    expect(codeOnCornerLabel('60,000')).toBeNull();
  });
  it('prioritizes explicit labels, preserves zeros and does not turn shoe sizes or models into codes', () => {
    const labeled = extractImageCodeCandidates('COD: 001\nPrecio $70.000 · EUR 41 al 44', 96);
    expect(labeled.detectedCode).toBe('001');
    expect(labeled.candidates).toContainEqual({ code: '001', confidence: expect.any(Number), evidence: 'label' });
    expect(labeled.candidates.some(({ code }) => ['41', '44', '70000'].includes(code))).toBe(false);

    const mixed = extractImageCodeCandidates('NIKE AB-123 Precio 💲70.000 EUR 41', 90);
    expect(mixed.candidates).toContainEqual({ code: 'AB-123', confidence: expect.any(Number), evidence: 'mixed-code' });
    expect(mixed.candidates.some(({ code }) => code === '70000' || code === '41')).toBe(false);
    expect(extractImageCodeCandidates('RETRO 40 · Tallas 38 a 42', 90).candidates).toEqual([]);
    const gender = extractImageCodeCandidates('*MUJER 096-215*', 96);
    expect(gender.detectedCode).toBe('096-215');
    expect(gender.candidates.map(({ code }) => code)).toEqual(['096-215']);
    expect(extractImageCodeCandidates('HOMBRE🕴️106-5', 96).detectedCode).toBe('106-5');
    expect(extractImageCodeCandidates('HOMBRE 🕴️174-54', 96).detectedCode).toBe('174-54');
    expect(codeOnCornerLabel('106-5 🌎')).toBe('106-5');
    expect(codeOnCornerLabel('106-5🌎')).toBe('106-5');
    expect(codeOnCornerLabel('106-5H 🌎')).toBe('106-5 H');
    expect(codeOnCornerLabel('096-215D🌍')).toBe('096-215 D');
    expect(codeOnCornerLabel('3846D Q |')).toBe('3846 D');
    expect(codeOnCornerLabel('[960 A o')).toBe('960 A');
    expect(codeOnCornerLabel(`${'ruido '.repeat(30)}277`)).toBeNull();
    expect(extractImageCodeCandidates('MUJER 40-44 · Precio $70.000', 96).detectedCode).toBeNull();
  });

  it('treats a blue-green globe on a pale label as evidence but not the same colors on a dark background', async () => {
    const globe = Buffer.from('<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" fill="white"/><circle cx="54" cy="54" r="17" fill="#1686d9"/><path d="M43 40h13l-4 9 12 3-5 12-13-4z" fill="#38ad49"/></svg>');
    const light = await sharp(globe).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(coloredGlobeInCorner(light.data, light.info.width, light.info.height, light.info.channels)).toBe('detected');
    const dark = await sharp(globe).flatten({ background: '#222' }).raw().toBuffer({ resolveWithObject: true });
    // A pale plaque is needed; the same colors on a dark photograph are inconclusive.
    const darkPixels = Buffer.from(dark.data);
    for (let i = 0; i < darkPixels.length; i += dark.info.channels) {
      if (darkPixels[i] === 255 && darkPixels[i + 1] === 255 && darkPixels[i + 2] === 255) darkPixels.fill(34, i, i + 3);
    }
    expect(coloredGlobeInCorner(darkPixels, dark.info.width, dark.info.height, dark.info.channels)).not.toBe('detected');
  });

  it('does not select a code automatically when multiple explicit labels appear', () => {
    const result = extractImageCodeCandidates('COD 143 · SKU 987', 92);
    expect(result.candidates.map(({ code }) => code)).toEqual(['143', '987']);
    expect(result.detectedCode).toBeNull();
  });

  it('detects the bundled Twemoji world mark and does not report it on a plain photo', async () => {
    const icon = await sharp(readFileSync(new URL('../assets/emoji/1f30e.png', import.meta.url)))
      .resize(48, 48, { fit: 'contain' }).png().toBuffer();
    const photoWithMark = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 214, g: 207, b: 190 } } })
      .composite([{ input: icon, left: 256, top: 256 }]).png().toBuffer();
    const positive = await detectEmbeddedWorldMark(photoWithMark);
    expect(positive.detected).toBe(true);
    expect(positive.variant).toBe('🌎');
    expect(positive.bounds).not.toBeNull();

    for (const [variant, fileName] of [['🌍', '1f30d.png'], ['🌏', '1f30f.png'], ['🌐', '1f310.png']] as const) {
      const otherIcon = await sharp(readFileSync(new URL(`../assets/emoji/${fileName}`, import.meta.url))).resize(48, 48, { fit: 'contain' }).png().toBuffer();
      const otherPhoto = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 214, g: 207, b: 190 } } })
        .composite([{ input: otherIcon, left: 256, top: 256 }]).png().toBuffer();
      const otherDetection = await detectEmbeddedWorldMark(otherPhoto);
      expect(otherDetection.detected).toBe(true);
      expect(otherDetection.variant).toBe(variant);
    }

    const plainPhoto = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 214, g: 207, b: 190 } } }).png().toBuffer();
    expect((await detectEmbeddedWorldMark(plainPhoto)).detected).toBe(false);
  });

  it.skipIf(!hasNativeEmojiRenderer())('detects the native system emoji style used by the photo label', async () => {
    const icon = await renderEmojiGraphic('🌎', 48, 'native');
    const photoWithMark = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 214, g: 207, b: 190 } } })
      .composite([{ input: icon, left: 256, top: 256 }]).png().toBuffer();
    const detection = await detectEmbeddedWorldMark(photoWithMark);
    expect(detection.detected, JSON.stringify(detection)).toBe(true);
    expect(['🌎', '🌍', '🌏', '🌐']).toContain(detection.variant);
  });
});
