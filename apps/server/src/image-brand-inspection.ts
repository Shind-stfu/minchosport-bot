import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BRAND_MODEL_ID = 'florence-2-large-ft@04ace749+qwen3.5-4b-onnx-q4@23ac3352+logo-crops-v4+qwen-no-think-v1+gpu-fallback-v1';

export type ImageInferenceDevice = 'auto' | 'gpu' | 'cpu' | 'dml' | 'webgpu';
export type BrandCandidateScore = { brand: string; score: number; supportCount?: number };
export type ImageBrandInspection = {
  modelId: string;
  status: 'review' | 'confirmed' | 'unknown' | 'failed';
  suggestedBrand: string | null;
  confirmedBrand: string | null;
  score: number;
  candidates: BrandCandidateScore[];
  evidence: { captionCandidates: string[]; ocrCandidates: string[]; retrieval?: { route: 'exact' | 'shadow' | 'similar'; brand: string | null; score?: number; margin?: number; supportCount?: number; elapsedMs?: number; error?: string }; inferenceDevice?: string; visualBrand?: string | null; visualAnswer?: string; visualLogoText?: string; visualEvidence?: string; visualConfidence?: number; visualModel?: string; visualError?: string; brandConflict?: boolean };
  autoEligible: boolean;
  reason: string;
  error: string | null;
};

type Job = { resolve: (result: ImageBrandInspection | boolean | number[][]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; onProgress?: (progress: number) => void };

/** Runs open-vocabulary brand scoring in a worker so ONNX never blocks the API thread. */
export class ImageBrandInspector {
  private worker: Worker | undefined;
  private pending = new Map<number, Job>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly cacheDirectory: string, private readonly timeoutMs = 3_600_000, private readonly inferenceDevice: ImageInferenceDevice = 'auto') {}

  inspect(source: Buffer, candidates: string[], evidence: ImageBrandInspection['evidence'], onProgress?: (progress: number) => void): Promise<ImageBrandInspection> {
    return this.request({ action: 'inspect', source, candidates, evidence }, onProgress).then((result) => {
      if (typeof result === 'boolean' || Array.isArray(result)) throw new Error('Respuesta inválida del clasificador de marcas.');
      return result;
    });
  }

  async embedShoes(source: Buffer): Promise<number[][]> {
    const result = await this.request({ action: 'embed', source, candidates: [], evidence: { captionCandidates: [], ocrCandidates: [] } });
    if (!Array.isArray(result)) throw new Error('Respuesta inválida del codificador visual.');
    return result;
  }

  hasFootwear(source: Buffer): Promise<boolean> {
    return this.request({ action: 'screen', source, candidates: [], evidence: { captionCandidates: [], ocrCandidates: [] } }).then((result) => {
      if (typeof result !== 'boolean') throw new Error('Respuesta inválida al revisar la imagen del proveedor.');
      return result;
    });
  }

  private request(payload: { action: 'inspect' | 'screen' | 'embed'; source: Buffer; candidates: string[]; evidence: ImageBrandInspection['evidence'] }, onProgress?: (progress: number) => void): Promise<ImageBrandInspection | boolean | number[][]> {
    if (this.closed) return Promise.reject(new Error('El clasificador de marcas está cerrado.'));
    const worker = this.getWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('El análisis de marca superó el tiempo límite.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, ...(onProgress ? { onProgress } : {}) });
      worker.postMessage({ id, ...payload });
    });
  }

  async close() {
    this.closed = true;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('El clasificador de marcas se cerró.')); }
    this.pending.clear();
    await this.worker?.terminate();
  }

  private getWorker() {
    if (this.worker) return this.worker;
    let workerFile = new URL('./image-brand-inspection-worker.js', import.meta.url);
    if (!existsSync(workerFile)) {
      const source = new URL('./image-brand-inspection-worker.ts', import.meta.url);
      const tsImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
      workerFile = new URL(`data:text/javascript,${encodeURIComponent(`import { tsImport } from ${JSON.stringify(tsImport)}; await tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)});`)}`);
    }
    this.worker = new Worker(workerFile, { workerData: { cacheDirectory: this.cacheDirectory, inferenceDevice: this.inferenceDevice }, execArgv: [] });
    this.worker.on('message', (message: { id: number; result?: ImageBrandInspection; hasFootwear?: boolean; vectors?: number[][]; error?: string; progress?: number }) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      if (typeof message.progress === 'number') { job.onProgress?.(message.progress); return; }
      this.pending.delete(message.id); clearTimeout(job.timer);
      if (message.result) job.resolve(message.result);
      else if (message.vectors) job.resolve(message.vectors);
      else if (typeof message.hasFootwear === 'boolean') job.resolve(message.hasFootwear);
      else job.reject(new Error(message.error ?? 'Respuesta inválida del clasificador de marcas.'));
    });
    this.worker.on('error', (error) => this.failWorker(error));
    this.worker.on('exit', (code) => { if (!this.closed && code !== 0) this.failWorker(new Error(`El worker de marcas terminó con código ${code}.`)); });
    return this.worker;
  }

  private failWorker(error: Error) {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); this.worker = undefined;
  }
}
