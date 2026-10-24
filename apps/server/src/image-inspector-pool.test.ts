import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageInspectorPool } from './image-inspector-pool.js';
const fixture = new URL('./test-fixtures/image-worker.cjs', import.meta.url);

describe('isolated image workers', () => {
  it('keeps the main event loop responsive during pixel scans and routes parallel results to the right photo', async () => {
    const pool = new ImageInspectorPool('/unused', 2, 3000, fixture);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const results = await Promise.all([1,4,5].map((value) => pool.inspect(Buffer.from([value]))));
      expect(results.map((result) => result.ocrText)).toEqual(['1','4','5']);
      expect(ticks).toBeGreaterThan(5);
    } finally { clearInterval(timer); await pool.close(); }
  });
  it('replaces crashed or timed out workers and continues the queue', async () => {
    const pool = new ImageInspectorPool('/unused', 1, 500, fixture);
    try {
      await expect(pool.inspect(Buffer.from([3]))).rejects.toThrow('terminó');
      await expect(pool.inspect(Buffer.from([2]))).rejects.toThrow('tiempo límite');
      expect((await pool.inspect(Buffer.from([1]))).ocrText).toBe('1');
    } finally { await pool.close(); }
  });
  it('rejects active and waiting work on shutdown', async () => {
    const pool = new ImageInspectorPool('/unused', 1, 3000, fixture);
    const settled = Promise.allSettled([pool.inspect(Buffer.from([2])),pool.inspect(Buffer.from([1]))]);
    await pool.close();
    expect((await settled).map((result) => result.status)).toEqual(['rejected','rejected']);
    await expect(pool.inspect(Buffer.from([1]))).rejects.toThrow('cerrado');
  });
  it('loads the actual TypeScript worker in dev/test and reports an invalid image without using OCR or the network', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'mincho-worker-test-'));
    const pool = new ImageInspectorPool(cache, 1, 10000);
    try { await expect(pool.inspect(Buffer.from('invalid image'))).rejects.toThrow(/Input|buffer|format/iu); }
    finally { await pool.close(); rmSync(cache, { recursive: true, force: true }); }
  });
});
