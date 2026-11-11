import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDatabase } from './database.js';
import type { ImageInspection } from './image-inspection.js';
import { IMAGE_ENGINE_VERSION, type ImageInspector } from './image-engine.js';
import { detectJordanBrandSignal, extractBrandCandidates, extractCatalogBrandCandidates, normalizeBrandName } from './brand-candidates.js';
import { brandSourcePredictions, evaluateBrandSuggestions } from './brand-evaluation.js';
import { BRAND_MODEL_ID, ImageBrandInspector, type ImageBrandInspection } from './image-brand-inspection.js';
import { writeApplicationLog } from './application-log.js';
import { applyConfirmedBrandToApprovedDescription, applyPrimaryVisionBrandToApprovedDescription, reconcilePrimaryVisionBrandDescriptions } from './approved-brand-description.js';

export class ImageInspectionCoordinator {
  private jobs = new Map<string, Promise<void>>();
  private waiting: Array<{ assetId: string; force: boolean; finish: () => void }> = [];
  private active = 0;
  private inFlight = new Map<string, Promise<ImageInspection>>();
  private sourceLoads = new Map<string, Promise<Buffer>>();
  private catalogCandidateCache = new Map<string, { expiresAt: number; candidates: string[] }>();
  private closed = false;

  constructor(private readonly db: AppDatabase, private readonly dataDirectory: string, private readonly inspector: ImageInspector,
    private readonly brandInspector?: Pick<ImageBrandInspector, 'inspect'> & Partial<Pick<ImageBrandInspector, 'close'>>) {}

  private get version() { return this.inspector.version ?? IMAGE_ENGINE_VERSION; }
  private get concurrency() { return Math.max(1, Math.min(4, this.inspector.concurrency ?? 1)); }

  status(sessionId: string) {
    const counts = this.db.prepare(`SELECT s.status,COUNT(*) as count FROM image_marking_state s
      JOIN media_assets m ON m.id=s.media_asset_id JOIN products p ON p.id=m.product_id WHERE p.session_id=? GROUP BY s.status`).all(sessionId);
    return { version: this.version, concurrency: this.concurrency, counts };
  }

  resume(): void {
    reconcilePrimaryVisionBrandDescriptions(this.db);
    const assets = this.db.prepare(`SELECT m.id FROM media_assets m LEFT JOIN image_marking_state s ON s.media_asset_id=m.id
      LEFT JOIN image_inspections i ON i.media_asset_id=m.id
      LEFT JOIN image_brand_inspections b ON b.media_asset_id=m.id
      WHERE s.media_asset_id IS NULL OR s.status IN ('pending','running') OR (s.status='complete' AND COALESCE(i.engine_version,'')<>?)
        OR (? AND (b.media_asset_id IS NULL OR b.model_id<>? OR b.status='failed'))`).all(this.version, this.brandInspector ? 1 : 0, BRAND_MODEL_ID) as Array<{ id: string }>;
    for (const asset of assets) this.schedule(asset.id);
  }

  schedule(assetId: string, force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.jobs.has(assetId)) return this.jobs.get(assetId)!;
    const asset = this.db.prepare('SELECT id FROM media_assets WHERE id=?').get(assetId);
    if (!asset) return Promise.resolve();
    const existing = this.db.prepare(`SELECT s.status,i.engine_version,b.model_id,b.status as brand_status FROM image_marking_state s
      LEFT JOIN image_inspections i ON i.media_asset_id=s.media_asset_id LEFT JOIN image_brand_inspections b ON b.media_asset_id=s.media_asset_id
      WHERE s.media_asset_id=?`).get(assetId) as { status: string; engine_version: string | null; model_id: string | null; brand_status: string | null } | undefined;
    if (!force && existing?.status === 'complete' && existing.engine_version === this.version
      && (!this.brandInspector || existing.model_id === BRAND_MODEL_ID && existing.brand_status !== 'failed')) return Promise.resolve();
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
    await this.brandInspector?.close?.();
    await this.inspector.close?.();
  }

  private async inspectOne(assetId: string, force: boolean): Promise<void> {
    const asset = this.db.prepare(`SELECT m.file_name,m.sha256,p.id as product_id,p.session_id,p.raw_text FROM media_assets m
      JOIN products p ON p.id=m.product_id WHERE m.id=?`).get(assetId) as { file_name: string; sha256: string; product_id: string; session_id: string; raw_text: string } | undefined;
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
      let source: Buffer | undefined;
      if (!inspection || this.brandInspector) {
        let loading = this.sourceLoads.get(asset.sha256);
        if (!loading) { loading = readFile(join(this.dataDirectory, 'media', asset.file_name)); this.sourceLoads.set(asset.sha256, loading); }
        try { source = await loading; }
        finally { if (this.sourceLoads.get(asset.sha256) === loading) this.sourceLoads.delete(asset.sha256); }
      }
      if (!inspection) {
        let pending = !force ? this.inFlight.get(key) : undefined;
        if (pending) cacheHit = true;
        else {
          pending = Promise.resolve(source!).then((image) => this.inspector.inspect(image));
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
      if (this.brandInspector && source && this.db.prepare('SELECT 1 FROM media_assets WHERE id=?').get(assetId)) {
        const registry = this.db.prepare('SELECT normalized_name as normalizedName,display_name as displayName,aliases_json as aliasesJson FROM shoe_brand_registry ORDER BY display_name').all() as Array<{ normalizedName: string; displayName: string; aliasesJson: string }>;
        const aliasToCanonical = new Map<string, string>();
        for (const row of registry) for (const term of [row.displayName, ...(JSON.parse(row.aliasesJson) as string[])]) aliasToCanonical.set(normalizeBrandName(term), row.displayName);
        const knownBrands = registry.flatMap((row) => [row.displayName, ...(JSON.parse(row.aliasesJson) as string[])]);
        const captionSignals = extractBrandCandidates(asset.raw_text);
        const ocrSignals = extractBrandCandidates(inspection.ocrText, [], { allowLowercaseWords: true });
        const containsTerm = (text: string, term: string) => ` ${normalizeBrandName(text)} `.includes(` ${normalizeBrandName(term)} `);
        const knownCaptionSignals = knownBrands.filter((brand) => containsTerm(asset.raw_text, brand));
        const knownOcrSignals = knownBrands.filter((brand) => containsTerm(inspection.ocrText, brand));
        const canonicalize = (brands: string[]) => [...new Set(brands.map((brand) => aliasToCanonical.get(normalizeBrandName(brand)) ?? brand))];
        const captions = canonicalize([...captionSignals, ...knownCaptionSignals]);
        const ocrCandidates = canonicalize([...ocrSignals, ...knownOcrSignals]);
        const cachedCatalog = this.catalogCandidateCache.get(asset.session_id);
        const catalogCandidates = cachedCatalog && cachedCatalog.expiresAt > Date.now() ? cachedCatalog.candidates : (() => {
          const titles = this.db.prepare('SELECT title FROM products WHERE session_id=? ORDER BY created_at DESC LIMIT 2000')
            .all(asset.session_id).map((row) => (row as { title: string }).title);
          const learned = extractCatalogBrandCandidates(titles, registry.map((row) => row.displayName), 32);
          this.catalogCandidateCache.set(asset.session_id, { expiresAt: Date.now() + 60_000, candidates: learned });
          return learned;
        })();
        const candidates = [...new Map([...captions, ...ocrCandidates, ...registry.map((row) => row.displayName), ...catalogCandidates]
          .map((brand) => [normalizeBrandName(brand), brand])).values()];
        try {
          const normalizedKnown = new Map(registry.map((row) => [row.normalizedName, row.displayName]));
          const referenceRows = this.db.prepare(`SELECT r.normalized_brand as normalizedBrand,m.id as assetId,m.file_name as fileName,m.sha256 as sha256,r.created_at as createdAt
            FROM shoe_brand_references r JOIN media_assets m ON m.id=r.media_asset_id
            WHERE r.normalized_brand IN (SELECT normalized_name FROM shoe_brand_registry)
              AND NOT EXISTS (SELECT 1 FROM shoe_brand_labels l WHERE l.media_asset_id=m.id AND l.split='holdout')
            ORDER BY r.normalized_brand,r.created_at`).all() as Array<{ normalizedBrand: string; assetId: string; fileName: string; sha256: string; createdAt: string }>;
          const rowsByBrand = new Map<string, typeof referenceRows>();
          const hashesByBrand = new Map<string, Set<string>>();
          for (const row of referenceRows) {
            if (row.assetId === assetId || row.sha256 === asset.sha256 || !normalizedKnown.has(row.normalizedBrand)) continue;
            const hashes = hashesByBrand.get(row.normalizedBrand) ?? new Set<string>();
            if (hashes.has(row.sha256)) continue;
            hashes.add(row.sha256); hashesByBrand.set(row.normalizedBrand, hashes);
            const rows = rowsByBrand.get(row.normalizedBrand) ?? [];
            rows.push(row); rowsByBrand.set(row.normalizedBrand, rows);
          }
          const balancedReferenceRows: typeof referenceRows = [];
          for (const [normalized, rows] of rowsByBrand) {
            const limit = Math.min(rows.length, 8);
            for (let index = 0; index < limit; index += 1) {
              const selectedIndex = limit === 1 ? 0 : Math.round(index * (rows.length - 1) / (limit - 1));
              balancedReferenceRows.push(rows[selectedIndex]!);
            }
          }
          const selectedReferences: Array<{ brand: string; fileName: string }> = [];
          const brandOrder = [...new Set(balancedReferenceRows.map((row) => row.normalizedBrand))].sort();
          for (let position = 0; position < 8 && selectedReferences.length < 48; position += 1) {
            for (const normalized of brandOrder) {
              const row = balancedReferenceRows.filter((candidate) => candidate.normalizedBrand === normalized)[position];
              if (row && selectedReferences.length < 48) selectedReferences.push({ brand: normalizedKnown.get(normalized)!, fileName: row.fileName });
            }
          }
          const referenceImages = await Promise.all(selectedReferences.map(async (reference) => ({
            brand: reference.brand,
            source: await readFile(join(this.dataDirectory, 'media', reference.fileName)),
          })));
          const rawResult = await this.brandInspector.inspect(source, candidates, { captionCandidates: captions, ocrCandidates }, referenceImages);
          const jordanBrand = aliasToCanonical.get(normalizeBrandName('JUMPMAN')) ?? 'Jordan';
          const canonicalize = (brand: string | null) => {
            if (!brand) return null;
            if (detectJordanBrandSignal([brand])) return jordanBrand;
            return aliasToCanonical.get(normalizeBrandName(brand)) ?? brand;
          };
          const jordanSignal = detectJordanBrandSignal([rawResult.evidence.visualLogoText, rawResult.evidence.visualEvidence, rawResult.evidence.visualAnswer]);
          const jordanMarkDetected = jordanSignal !== null;
          const modelVisualBrand = canonicalize(rawResult.evidence.visualBrand ?? null);
          const normalizedVisualBrand = jordanMarkDetected ? jordanBrand : modelVisualBrand;
          const normalizedSuggestion = jordanMarkDetected ? jordanBrand : canonicalize(rawResult.suggestedBrand);
          const result: ImageBrandInspection = {
            ...rawResult,
            status: jordanMarkDetected ? 'review' : rawResult.status,
            suggestedBrand: normalizedSuggestion,
            confirmedBrand: jordanMarkDetected ? null : canonicalize(rawResult.confirmedBrand),
            reason: jordanMarkDetected
              ? modelVisualBrand && normalizeBrandName(modelVisualBrand) !== normalizeBrandName(jordanBrand)
                ? `${jordanSignal === 'jumpman' ? 'El logo Jumpman' : 'La marca Jordan'} se asocia con Jordan; Florence + Qwen también propuso ${modelVisualBrand}, así que queda para revisión.`
                : `${jordanSignal === 'jumpman' ? 'El logo Jumpman' : 'La marca Jordan'} fue identificado en la zapatilla.`
              : rawResult.reason,
            candidates: rawResult.candidates.map((candidate) => ({ ...candidate, brand: canonicalize(candidate.brand)! })),
            evidence: {
              ...rawResult.evidence,
              visualBrand: normalizedVisualBrand,
              ...(jordanMarkDetected && modelVisualBrand && normalizeBrandName(modelVisualBrand) !== normalizeBrandName(jordanBrand)
                ? { brandConflict: true } : {}),
              ...(rawResult.evidence.referenceMatches ? { referenceMatches: rawResult.evidence.referenceMatches.map((candidate) => ({ ...candidate, brand: canonicalize(candidate.brand)! })) } : {}),
              ...(rawResult.evidence.soleMatchMatches ? { soleMatchMatches: rawResult.evidence.soleMatchMatches.map((candidate) => ({ ...candidate, brand: canonicalize(candidate.brand)! })) } : {}),
              ...(rawResult.evidence.sneakerCandidates ? { sneakerCandidates: rawResult.evidence.sneakerCandidates.map((candidate) => ({ ...candidate, brand: canonicalize(candidate.brand)! })) } : {}),
            },
          };
          const reviewed = this.db.prepare(`SELECT predicted_brand as predictedBrand,expected_brand as expectedBrand
            FROM shoe_brand_evaluation_samples WHERE model_id=? AND split='holdout' AND media_asset_id<>?`)
            .all(BRAND_MODEL_ID, assetId) as Array<{ predictedBrand: string | null; expectedBrand: string | null }>;
          const gate = evaluateBrandSuggestions(reviewed);
          const visualConfirmsSuggestion = Boolean(result.suggestedBrand && result.evidence.visualBrand
            && normalizeBrandName(result.suggestedBrand) === normalizeBrandName(result.evidence.visualBrand));
          const autoEligible = visualConfirmsSuggestion && result.score >= 0.8 && !result.evidence.brandConflict
            && gate.autoEligibleBrands.some((brand) => normalizeBrandName(brand) === normalizeBrandName(result.suggestedBrand!));
          const brand: ImageBrandInspection = autoEligible ? {
            ...result, status: 'confirmed', confirmedBrand: result.suggestedBrand, autoEligible: true,
            reason: 'Marca asignada automáticamente: Florence + Qwen coincide en el logo y esta marca superó 95 % de precisión en al menos 20 fotos de evaluación independientes.',
          } : result;
          this.saveBrandInspection(assetId, brand);
          const holdoutLabel = this.db.prepare(`SELECT expected_brand as expectedBrand FROM shoe_brand_labels
            WHERE media_asset_id=? AND split='holdout'`).get(assetId) as { expectedBrand: string | null } | undefined;
          if (holdoutLabel) this.db.prepare(`INSERT INTO shoe_brand_evaluation_samples(media_asset_id,model_id,predicted_brand,expected_brand,reviewed_at,split,source_predictions_json)
            VALUES (?,?,?,?,?,'holdout',?) ON CONFLICT(media_asset_id) DO UPDATE SET model_id=excluded.model_id,
              predicted_brand=excluded.predicted_brand,expected_brand=excluded.expected_brand,reviewed_at=excluded.reviewed_at,
              split='holdout',source_predictions_json=excluded.source_predictions_json`)
            .run(assetId, BRAND_MODEL_ID, result.suggestedBrand, holdoutLabel.expectedBrand, new Date().toISOString(), JSON.stringify(brandSourcePredictions(result.candidates, result.evidence)));
          const savedBrand = this.db.prepare('SELECT status,confirmed_brand as confirmedBrand,suggested_brand as suggestedBrand,evidence_json as evidence FROM image_brand_inspections WHERE media_asset_id=?')
            .get(assetId) as { status: string; confirmedBrand: string | null; suggestedBrand: string | null; evidence: string } | undefined;
          if (savedBrand?.status === 'confirmed' && savedBrand.confirmedBrand) {
            applyConfirmedBrandToApprovedDescription(this.db, asset.product_id, savedBrand.confirmedBrand);
          } else if (savedBrand?.status === 'review' && savedBrand.suggestedBrand) {
            try {
              const evidence = JSON.parse(savedBrand.evidence) as { visualBrand?: string | null };
              if (evidence.visualBrand && normalizeBrandName(evidence.visualBrand) === normalizeBrandName(savedBrand.suggestedBrand)) {
                applyPrimaryVisionBrandToApprovedDescription(this.db, asset.product_id, evidence.visualBrand);
              }
            } catch { /* The suggestion remains visible for review if its evidence is malformed. */ }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 300) : 'Error local desconocido.';
          this.saveBrandInspection(assetId, { modelId: BRAND_MODEL_ID, status: 'failed', suggestedBrand: null, confirmedBrand: null, score: 0, candidates: [], evidence: { captionCandidates: captions, ocrCandidates, unknownScore: 0 }, autoEligible: false, reason: 'No se pudo completar la detección local de marca.', error: reason });
        }
      }
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

  private saveBrandInspection(assetId: string, brand: ImageBrandInspection) {
    const inspectedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO image_brand_inspections(media_asset_id,model_id,status,suggested_brand,confirmed_brand,score,candidates_json,evidence_json,auto_eligible,manual_override,reason,error,inspected_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(media_asset_id) DO UPDATE SET model_id=excluded.model_id,
      status=CASE WHEN image_brand_inspections.manual_override=1 THEN image_brand_inspections.status ELSE excluded.status END,
      suggested_brand=excluded.suggested_brand,confirmed_brand=CASE WHEN image_brand_inspections.manual_override=1 THEN image_brand_inspections.confirmed_brand ELSE excluded.confirmed_brand END,
      score=excluded.score,candidates_json=excluded.candidates_json,evidence_json=excluded.evidence_json,auto_eligible=excluded.auto_eligible,
      manual_override=image_brand_inspections.manual_override,reason=CASE WHEN image_brand_inspections.manual_override=1 THEN image_brand_inspections.reason ELSE excluded.reason END,
      error=excluded.error,inspected_at=excluded.inspected_at`)
      .run(assetId, brand.modelId, brand.status, brand.suggestedBrand, brand.confirmedBrand, brand.score, JSON.stringify(brand.candidates), JSON.stringify(brand.evidence), Number(brand.autoEligible), brand.reason, brand.error, inspectedAt);
    const sessionId = (this.db.prepare('SELECT p.session_id FROM media_assets m JOIN products p ON p.id=m.product_id WHERE m.id=?').get(assetId) as { session_id: string } | undefined)?.session_id ?? 'main';
    writeApplicationLog(this.db, { sessionId, category: 'products', action: brand.status === 'failed' ? 'product.image.brand.failed' : brand.autoEligible ? 'product.image.brand.auto-assigned' : 'product.image.brand.suggested',
      entityType: 'media_asset', entityId: assetId, message: brand.status === 'failed' ? 'No se pudo detectar la marca de la fotografía' : brand.autoEligible ? `Marca asignada automáticamente: ${brand.confirmedBrand}` : brand.suggestedBrand ? `Marca sugerida: ${brand.suggestedBrand}` : 'No se detectó una marca legible',
      level: brand.status === 'failed' ? 'warning' : 'info', details: { suggestion: brand.suggestedBrand, score: brand.score, candidateCount: brand.candidates.length, modelId: brand.modelId }, createdAt: inspectedAt });
  }
}
