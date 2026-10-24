import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDatabase } from './database.js';
import type { ImageInspection } from './image-inspection.js';
import { IMAGE_ENGINE_VERSION, type ImageInspector } from './image-engine.js';
import { writeApplicationLog } from './application-log.js';

export class ImageInspectionCoordinator {
  private jobs = new Map<string, Promise<void>>();
  private waiting: Array<{ assetId: string; force: boolean; finish: () => void }> = [];
  private active = 0;
  private inFlight = new Map<string, Promise<ImageInspection>>();
  private closed = false;

  constructor(private readonly db: AppDatabase, private readonly dataDirectory: string, private readonly inspector: ImageInspector) {}

  private get version() { return this.inspector.version ?? IMAGE_ENGINE_VERSION; }
  private get concurrency() { return Math.max(1, Math.min(4, this.inspector.concurrency ?? 1)); }

  status(sessionId: string) {
    const counts = this.db.prepare(`SELECT s.status,COUNT(*) as count FROM image_marking_state s
      JOIN media_assets m ON m.id=s.media_asset_id JOIN products p ON p.id=m.product_id WHERE p.session_id=? GROUP BY s.status`).all(sessionId);
    return { version: this.version, concurrency: this.concurrency, counts };
  }

  resume(): void {
    const assets = this.db.prepare(`SELECT m.id FROM media_assets m LEFT JOIN image_marking_state s ON s.media_asset_id=m.id
      LEFT JOIN image_inspections i ON i.media_asset_id=m.id
      WHERE s.media_asset_id IS NULL OR s.status IN ('pending','running') OR (s.status='complete' AND COALESCE(i.engine_version,'')<>?)`).all(this.version) as Array<{ id: string }>;
    for (const asset of assets) this.schedule(asset.id);
  }

  schedule(assetId: string, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.jobs.has(assetId)) return this.jobs.get(assetId)!;
    const asset = this.db.prepare('SELECT id FROM media_assets WHERE id=?').get(assetId);
    if (!asset) return Promise.resolve();
    const existing = this.db.prepare('SELECT s.status,i.engine_version FROM image_marking_state s LEFT JOIN image_inspections i ON i.media_asset_id=s.media_asset_id WHERE s.media_asset_id=?').get(assetId) as { status: string; engine_version: string | null } | undefined;
    if (!force && existing?.status === 'complete' && existing.engine_version === this.version) return Promise.resolve();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,error,updated_at) VALUES (?,'pending','[]',NULL,NULL,?)
      ON CONFLICT(media_asset_id) DO UPDATE SET status='pending',error=NULL,updated_at=excluded.updated_at`).run(assetId, now);
    let finish!: () => void;
    const job = new Promise<void>((resolve) => { finish = resolve; });
    this.jobs.set(assetId, job);
    this.waiting.push({ assetId, force, finish });
    this.pump();
    return job;
  }

  private pump() {
    if (this.closed) return;
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active += 1;
      void this.inspectOne(job.assetId, job.force).catch(() => undefined).finally(() => {
        this.active -= 1; this.jobs.delete(job.assetId); job.finish(); this.pump();
      });
    }
  }

  async close() {
    this.closed = true;
    for (const job of this.waiting.splice(0)) { this.jobs.delete(job.assetId); job.finish(); }
    await Promise.all([...this.jobs.values()]);
    await this.inspector.close?.();
  }

  private async inspectOne(assetId: string, force: boolean): Promise<void> {
    const asset = this.db.prepare(`SELECT m.file_name,m.sha256,p.id as product_id,p.session_id FROM media_assets m
      JOIN products p ON p.id=m.product_id WHERE m.id=?`).get(assetId) as { file_name: string; sha256: string; product_id: string; session_id: string } | undefined;
    if (!asset) return;
    this.db.prepare("UPDATE image_marking_state SET status='running',updated_at=? WHERE media_asset_id=?").run(new Date().toISOString(), assetId);
    try {
      const started = performance.now();
      const key = `${this.version}:${asset.sha256}`;
      if (force) {
        // Finish an older scan of these bytes before replacing its cached result.
        await this.inFlight.get(key)?.catch(() => undefined);
        this.db.prepare('DELETE FROM image_analysis_cache WHERE sha256=? AND engine_version=?').run(asset.sha256, this.version);
      }
      let inspection: ImageInspection | undefined;
      let cacheHit = false;
      if (!force) {
        const cached = this.db.prepare('SELECT result_json FROM image_analysis_cache WHERE sha256=? AND engine_version=?').get(asset.sha256, this.version) as { result_json: string } | undefined;
        if (cached) {
          try {
            const result = JSON.parse(cached.result_json) as ImageInspection;
            if (!result.ocrError && Array.isArray(result.regions) && typeof result.ocrText === 'string' && result.world && Array.isArray(result.codeCandidates)) { inspection = result; cacheHit = true; }
          } catch { /* Invalid cached data is recomputed from the original. */ }
        }
      }
      if (!inspection) {
        let pending = !force ? this.inFlight.get(key) : undefined;
        if (pending) cacheHit = true;
        else {
          pending = readFile(join(this.dataDirectory, 'media', asset.file_name)).then((source) => this.inspector.inspect(source));
          this.inFlight.set(key, pending);
        }
        try { inspection = await pending; }
        finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
      }
      // A photo can be deleted while OCR runs; never recreate its state or cache.
      if (!this.db.prepare('SELECT 1 FROM media_assets WHERE id=?').get(assetId)) return;
      const durationMs = Math.round(performance.now() - started);
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO image_inspections(media_asset_id,ocr_text,ocr_confidence,ocr_error,code_candidates_json,detected_code,code_confidence,world_variant,world_confidence,inspected_at,engine_version,duration_ms,ocr_passes,cache_hit,world_detected)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(media_asset_id) DO UPDATE SET ocr_text=excluded.ocr_text,ocr_confidence=excluded.ocr_confidence,ocr_error=excluded.ocr_error,
          code_candidates_json=excluded.code_candidates_json,detected_code=excluded.detected_code,code_confidence=excluded.code_confidence,
          world_variant=excluded.world_variant,world_confidence=excluded.world_confidence,inspected_at=excluded.inspected_at,engine_version=excluded.engine_version,duration_ms=excluded.duration_ms,ocr_passes=excluded.ocr_passes,cache_hit=excluded.cache_hit,world_detected=excluded.world_detected`)
          .run(assetId, inspection.ocrText, inspection.ocrConfidence, inspection.ocrError, JSON.stringify(inspection.codeCandidates), inspection.detectedCode,
            inspection.detectedCodeConfidence, inspection.world.detected ? inspection.world.variant : null, inspection.world.confidence, now, this.version, durationMs, cacheHit ? 0 : inspection.metrics?.ocrPasses ?? null, cacheHit ? 1 : 0, inspection.world.detected ? 1 : 0);
        if (!inspection.ocrError) this.db.prepare(`INSERT OR REPLACE INTO image_analysis_cache(sha256,engine_version,result_json,created_at) VALUES (?,?,?,?)`).run(asset.sha256, this.version, JSON.stringify(inspection), now);
        this.db.prepare('UPDATE image_marking_state SET status=?,regions_json=?,error=?,updated_at=? WHERE media_asset_id=?')
          .run(inspection.ocrError ? 'failed' : 'complete', JSON.stringify(inspection.regions ?? []), inspection.ocrError, now, assetId);
        writeApplicationLog(this.db, { sessionId: asset.session_id, category: 'products', action: inspection.ocrError ? 'product.image.inspect.failed' : 'product.image.inspected',
          entityType: 'product', entityId: asset.product_id, message: inspection.ocrError ? 'La foto requiere revisión: falló el análisis local' : 'Se analizaron código y mundo de la fotografía',
          level: inspection.ocrError ? 'warning' : 'info', details: { assetId, code: inspection.detectedCode, world: inspection.world.variant, regions: inspection.regions?.length ?? 0, durationMs, ocrPasses: cacheHit ? 0 : inspection.metrics?.ocrPasses ?? null, cacheHit, engineVersion: this.version }, createdAt: now });
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Error local desconocido.';
      const now = new Date().toISOString();
      if (this.db.prepare('SELECT 1 FROM image_marking_state WHERE media_asset_id=?').get(assetId)) {
        this.db.prepare("UPDATE image_marking_state SET status='failed',error=?,updated_at=? WHERE media_asset_id=?").run(message, now, assetId);
        writeApplicationLog(this.db, { sessionId: asset.session_id, category: 'products', action: 'product.image.inspect.failed', entityType: 'product', entityId: asset.product_id,
          message: 'La foto requiere revisión: falló el análisis local', level: 'warning', details: { assetId, error: message }, createdAt: now });
      }
    }
  }
}
