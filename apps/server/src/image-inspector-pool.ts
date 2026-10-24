import { existsSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { IMAGE_ENGINE_VERSION, type ImageInspector } from './image-engine.js';
import type { ImageInspection } from './image-inspection.js';

type Job = { source: Buffer; resolve: (result: ImageInspection) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; job?: Job; timer?: ReturnType<typeof setTimeout> };

/** Isolates pixel scans and OCR from the server receiving WhatsApp messages. */
export class ImageInspectorPool implements ImageInspector {
  readonly version = IMAGE_ENGINE_VERSION;
  readonly concurrency: number;
  private slots = new Set<Slot>();
  private queue: Job[] = [];
  private closed = false;

  constructor(private readonly cachePath: string, concurrency = availableParallelism() >= 4 && freemem() >= 2 * 1024 ** 3 ? 2 : 1, private readonly timeoutMs = 120_000, private readonly workerEntry?: URL) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('El motor admite entre 1 y 4 procesos de análisis.');
    this.concurrency = concurrency;
  }

  inspect(source: Buffer): Promise<ImageInspection> {
    if (this.closed) return Promise.reject(new Error('El motor de imágenes está cerrado.'));
    return new Promise((resolve, reject) => { this.queue.push({ source, resolve, reject }); this.dispatch(); });
  }

  async close() {
    this.closed = true;
    const error = new Error('El motor de imágenes se cerró.');
    for (const job of this.queue.splice(0)) job.reject(error);
    const slots = [...this.slots]; this.slots.clear();
    for (const slot of slots) { clearTimeout(slot.timer); slot.job?.reject(error); }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  private createSlot(): Slot {
    let entry = this.workerEntry ?? new URL('./image-inspection-worker.js', import.meta.url);
    if (!existsSync(entry)) {
      // tsx dev/test sources; production starts the compiled .js directly.
      const source = new URL('./image-inspection-worker.ts', import.meta.url);
      entry = new URL(`data:text/javascript,${encodeURIComponent(`import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)});`)}`);
    }
    const slot: Slot = { worker: new Worker(entry, { workerData: { cachePath: this.cachePath }, execArgv: [] }) };
    this.slots.add(slot);
    slot.worker.on('message', (message: { result?: ImageInspection; error?: string }) => {
      if (!this.slots.has(slot) || !slot.job) return;
      clearTimeout(slot.timer);
      const job = slot.job; delete slot.job;
      if (message.result) job.resolve(message.result);
      else job.reject(new Error(message.error ?? 'Respuesta de análisis inválida.'));
      this.dispatch();
    });
    slot.worker.on('error', (error) => this.retire(slot, error));
    slot.worker.on('exit', (code) => this.retire(slot, new Error(`El proceso de análisis terminó (${code}).`)));
    return slot;
  }

  private retire(slot: Slot, error: Error) {
    if (!this.slots.delete(slot)) return;
    clearTimeout(slot.timer); slot.job?.reject(error);
    void slot.worker.terminate();
    this.dispatch();
  }

  private dispatch() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = [...this.slots].find((candidate) => !candidate.job);
      if (!slot && this.slots.size >= this.concurrency) return;
      try { slot ??= this.createSlot(); }
      catch (error) { this.queue.shift()!.reject(error instanceof Error ? error : new Error(String(error))); continue; }
      const active = slot;
      active.job = this.queue.shift()!;
      active.timer = setTimeout(() => this.retire(active, new Error('El análisis superó el tiempo límite. Vuelve a analizar la fotografía.')), this.timeoutMs);
      try { active.worker.postMessage(active.job.source); }
      catch (error) { this.retire(active, error instanceof Error ? error : new Error(String(error))); }
    }
  }
}
