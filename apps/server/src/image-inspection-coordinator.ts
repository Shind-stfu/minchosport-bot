import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from './database.js';
import type { ImageInspection, LocalImageInspector } from './image-inspection.js';
import { writeApplicationLog } from './application-log.js';

type Inspector = Pick<LocalImageInspector, 'inspect'> & Partial<Pick<LocalImageInspector, 'close'>>;

export class ImageInspectionCoordinator {
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<string>();
  private closed = false;

  constructor(private readonly db: AppDatabase, private readonly dataDirectory: string, private readonly inspector: Inspector) {}

  resume(): void {
    const assets = this.db.prepare(`SELECT m.id FROM media_assets m LEFT JOIN image_marking_state s ON s.media_asset_id=m.id
      WHERE s.media_asset_id IS NULL OR s.status IN ('pending','running')`).all() as Array<{ id: string }>;
    for (const asset of assets) this.schedule(asset.id);
  }

  schedule(assetId: string, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.queued.has(assetId)) return this.chain;
    const asset = this.db.prepare('SELECT id FROM media_assets WHERE id=?').get(assetId);
    if (!asset) return Promise.resolve();
    const existing = this.db.prepare('SELECT status FROM image_marking_state WHERE media_asset_id=?').get(assetId) as { status: string } | undefined;
    if (!force && existing?.status === 'complete') return Promise.resolve();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,error,updated_at) VALUES (?,'pending','[]',NULL,NULL,?)
      ON CONFLICT(media_asset_id) DO UPDATE SET status='pending',error=NULL,updated_at=excluded.updated_at`).run(assetId, now);
    this.queued.add(assetId);
    const job = this.chain.then(() => this.inspectOne(assetId)).catch(() => undefined).finally(() => { this.queued.delete(assetId); });
    this.chain = job;
    return job;
  }

  async close() {
    this.closed = true;
    await this.chain;
    await this.inspector.close?.();
  }

  private async inspectOne(assetId: string): Promise<void> {
    const asset = this.db.prepare(`SELECT m.file_name,p.id as product_id,p.session_id FROM media_assets m
      JOIN products p ON p.id=m.product_id WHERE m.id=?`).get(assetId) as { file_name: string; product_id: string; session_id: string } | undefined;
    if (!asset) return;
    this.db.prepare("UPDATE image_marking_state SET status='running',updated_at=? WHERE media_asset_id=?").run(new Date().toISOString(), assetId);
    try {
      const inspection: ImageInspection = await this.inspector.inspect(readFileSync(join(this.dataDirectory, 'media', asset.file_name)));
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO image_inspections(media_asset_id,ocr_text,ocr_confidence,ocr_error,code_candidates_json,detected_code,code_confidence,world_variant,world_confidence,inspected_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(media_asset_id) DO UPDATE SET ocr_text=excluded.ocr_text,ocr_confidence=excluded.ocr_confidence,ocr_error=excluded.ocr_error,
          code_candidates_json=excluded.code_candidates_json,detected_code=excluded.detected_code,code_confidence=excluded.code_confidence,
          world_variant=excluded.world_variant,world_confidence=excluded.world_confidence,inspected_at=excluded.inspected_at`)
          .run(assetId, inspection.ocrText, inspection.ocrConfidence, inspection.ocrError, JSON.stringify(inspection.codeCandidates), inspection.detectedCode,
            inspection.detectedCodeConfidence, inspection.world.detected ? inspection.world.variant : null, inspection.world.confidence, now);
        this.db.prepare('UPDATE image_marking_state SET status=?,regions_json=?,error=?,updated_at=? WHERE media_asset_id=?')
          .run(inspection.ocrError ? 'failed' : 'complete', JSON.stringify(inspection.regions ?? []), inspection.ocrError, now, assetId);
        writeApplicationLog(this.db, { sessionId: asset.session_id, category: 'products', action: inspection.ocrError ? 'product.image.inspect.failed' : 'product.image.inspected',
          entityType: 'product', entityId: asset.product_id, message: inspection.ocrError ? 'La foto requiere revisión: falló el análisis local' : 'Se analizaron código y mundo de la fotografía',
          level: inspection.ocrError ? 'warning' : 'info', details: { assetId, code: inspection.detectedCode, world: inspection.world.variant, regions: inspection.regions?.length ?? 0 }, createdAt: now });
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
