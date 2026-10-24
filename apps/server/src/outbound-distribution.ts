import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { addMargin, analyzePrices, extractShoeCode, formatCop, prepareOutgoingDescription, replacePriceCandidates } from '@tenis/core';
import type { AppDatabase } from './database.js';
import type { WhatsAppConnector } from './whatsapp.js';
import { genderIndicatorFromDescription, saveMarkedImage } from './image-marking.js';
import { writeApplicationLog } from './application-log.js';
import { markOptions, readMarkDecision } from './image-marking-decision.js';

const ASSEMBLY_IDLE_MS = 3_000;
type ProductSend = { controller: AbortController; operations: Set<Promise<void>> };

function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    operation.then(
      (value) => { signal.removeEventListener('abort', cancel); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', cancel); reject(error); },
    );
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

export class OutboundDistributionService {
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> | undefined;
  private sendOperation: Promise<void> = Promise.resolve();
  private sendCancellation = new AbortController();
  private clearingCatalog = false;
  private productSends = new Map<string, ProductSend>();

  constructor(
    private readonly db: AppDatabase,
    private readonly dataDirectory: string,
    private readonly whatsapp: WhatsAppConnector,
    private readonly logger: FastifyBaseLogger,
    private readonly enabled: boolean,
    readonly sessionId = 'main',
    private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => sleep(ms, undefined, { signal }),
  ) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE outbound_units SET status='uncertain',completed_at=?,error='La aplicación se cerró durante una transmisión; confirma en el grupo antes de reintentar.' WHERE session_id=? AND status='transmitting'").run(now, this.sessionId);
      this.db.prepare("UPDATE outbound_publications SET status='needs_review',updated_at=? WHERE session_id=? AND id IN (SELECT publication_id FROM outbound_units WHERE session_id=? AND status='uncertain')").run(now, this.sessionId, this.sessionId);
      this.db.prepare("UPDATE session_distribution_control SET status='paused',updated_at=? WHERE session_id=? AND status='running'").run(now, this.sessionId);
    })();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([this.currentTick, this.sendOperation]);
  }

  /** Cancels active and queued sends before deleting their rows and files. */
  async cancelSendsAndRun<T>(cleanup: () => T): Promise<T> {
    if (this.clearingCatalog) throw new Error('Ya se están eliminando los productos de esta cuenta.');
    this.clearingCatalog = true;
    this.sendCancellation.abort(new Error('Envío detenido al eliminar todos los productos de la cuenta.'));
    try {
      await Promise.all([this.currentTick, this.sendOperation]);
      return cleanup();
    } finally {
      this.sendCancellation = new AbortController();
      this.clearingCatalog = false;
    }
  }

  /** Cancels only references affected by selected-photo deletion. Other references keep sending. */
  async cancelProductsAndRun<T>(productIds: string[], cleanup: () => T): Promise<T> {
    if (this.clearingCatalog || productIds.some((id) => this.productSends.get(id)?.controller.signal.aborted)) {
      throw new Error('Ya se están eliminando fotos de esta selección.');
    }
    const sends = productIds.map((id) => ({ id, send: this.productSend(id) }));
    for (const { send } of sends) send.controller.abort(new Error('Envío detenido al eliminar fotos de esta referencia.'));
    try {
      await Promise.all(sends.flatMap(({ send }) => [...send.operations]));
      return cleanup();
    } finally {
      for (const { id, send } of sends) if (this.productSends.get(id) === send) this.productSends.delete(id);
    }
  }

  private productSend(id: string): ProductSend {
    let send = this.productSends.get(id);
    if (!send) {
      send = { controller: new AbortController(), operations: new Set() };
      this.productSends.set(id, send);
    }
    return send;
  }

  async processNow() {
    await this.tick();
  }

  status() {
    return (this.db.prepare('SELECT status FROM session_distribution_control WHERE session_id=?').get(this.sessionId) as { status: 'stopped' | 'paused' | 'running' }).status;
  }

  /** Sends one product only after an explicit request from the catalog. */
  async sendApprovedProduct(productId: string): Promise<{ groupCount: number; imageCount: number }> {
    this.sendCancellation.signal.throwIfAborted();
    if (!this.enabled) throw new Error('El envío real está deshabilitado. Revisa APP_MODE, WHATSAPP_ENABLED y WHATSAPP_SEND_ENABLED en .env.');
    if (this.whatsapp.status().status !== 'connected') throw new Error('Conecta WhatsApp antes de enviar.');
    const send = this.productSend(productId);
    const signal = AbortSignal.any([this.sendCancellation.signal, send.controller.signal]);
    signal.throwIfAborted();
    let release!: () => void;
    const previous = this.sendOperation;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    // A canceled queued reference must not let later requests bypass an earlier active send.
    this.sendOperation = previous.then(() => operation);
    send.operations.add(operation);
    try {
      await interruptible(previous, signal);
      signal.throwIfAborted();
      const product = this.db.prepare('SELECT status,output_text,session_id,supplier_id FROM products WHERE id=?').get(productId) as { status: string; output_text: string | null; session_id: string; supplier_id: string | null } | undefined;
      if (!product) throw new Error('Producto no encontrado.');
      if (product.session_id !== this.sessionId || !product.supplier_id) throw new Error('El producto no pertenece a esta cuenta o proveedor.');
      if (!['approved', 'simulated'].includes(product.status) || !product.output_text) throw new Error('Revisa y aprueba el precio y el texto antes de enviar.');

      const existing = this.db.prepare(`SELECT p.group_id,p.status,
          EXISTS(SELECT 1 FROM outbound_units u WHERE u.publication_id=p.id AND u.session_id=p.session_id AND u.status IN ('transmitting','uncertain')) as unresolved
        FROM outbound_publications p WHERE p.product_id=? AND p.session_id=?`).all(productId, this.sessionId) as Array<{ group_id: string; status: string; unresolved: number }>;
      if (existing.some((entry) => entry.status === 'needs_review' || entry.unresolved === 1)) throw new Error('Hay un envío incierto. Confirma el resultado en WhatsApp antes de volver a enviar.');
      const resumable = existing.some((entry) => entry.status === 'queued' || entry.status === 'in_progress');

      if (!resumable) {
        const selection = this.db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(this.sessionId) as { target_group_ids: string };
        const targets = JSON.parse(selection.target_group_ids) as string[];
        const sourceGroups = new Set((this.db.prepare("SELECT source_group_id FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL").all(this.sessionId) as Array<{ source_group_id: string }>).map((row) => row.source_group_id));
        if (targets.length < 1 || targets.length > 5 || targets.some((target) => sourceGroups.has(target))) {
          throw new Error('Guarda entre uno y cinco grupos destino, distintos de todos los proveedores de esta cuenta.');
        }
        const submitted = new Set(existing.filter((entry) => entry.status === 'submitted').map((entry) => entry.group_id));
        const pendingTargets = targets.filter((target) => !submitted.has(target));
        if (!pendingTargets.length) throw new Error('Este producto ya fue enviado a todos los grupos destino seleccionados.');
        await this.enqueueProduct(productId, pendingTargets);
      }
      signal.throwIfAborted();
      const queued = this.db.prepare("SELECT COUNT(DISTINCT p.group_id) as groups,COUNT(u.id) as images FROM outbound_publications p JOIN outbound_units u ON u.publication_id=p.id WHERE p.product_id=? AND p.session_id=? AND p.status IN ('queued','in_progress') AND u.status='pending'").get(productId, this.sessionId) as { groups: number; images: number };
      if (queued.groups === 0 || queued.images === 0) throw new Error('No hay destinos o fotografías válidas. Actualiza y guarda la selección de grupos.');
      while (await this.sendNextUnit(productId, signal)) { /* send photos sequentially */ }
      return { groupCount: queued.groups, imageCount: queued.images };
    } finally {
      release();
      send.operations.delete(operation);
      if (!send.operations.size && !send.controller.signal.aborted && this.productSends.get(productId) === send) this.productSends.delete(productId);
    }
  }

  /** Bulk sends only supplier products with an already clear, prepared price. */
  async approveAndSendAll(supplierId?: string, productIds?: string[]): Promise<{ sentProducts: number; sentGroups: number; sentImages: number; reviewRequired: number; skipped: number; skippedErrors: string[]; error?: string }> {
    const signal = this.sendCancellation.signal;
    signal.throwIfAborted();
    if (!this.enabled) throw new Error('El envío real está deshabilitado. Revisa APP_MODE, WHATSAPP_ENABLED y WHATSAPP_SEND_ENABLED en .env.');
    if (this.whatsapp.status().status !== 'connected') throw new Error('Conecta WhatsApp antes de enviar.');

    await this.processNow();
    signal.throwIfAborted();
    if (productIds) {
      if (new Set(productIds).size !== productIds.length) throw new Error('La selección contiene productos duplicados.');
      const idSlots = productIds.map(() => '?').join(',');
      const selectedProducts = this.db.prepare(`SELECT id FROM products WHERE session_id=? AND supplier_id IS NOT NULL AND id IN (${idSlots}) ${supplierId ? 'AND supplier_id=?' : ''}`)
        .all(...[this.sessionId, ...productIds, ...(supplierId ? [supplierId] : [])]) as Array<{ id: string }>;
      if (selectedProducts.length !== productIds.length) throw new Error('Una o más referencias seleccionadas no pertenecen a esta cuenta o proveedor. Actualiza el catálogo y vuelve a seleccionar.');
    }
    const productFilter = productIds?.length ? `AND p.id IN (${productIds.map(() => '?').join(',')})` : '';
    const queryParameters = [this.sessionId, ...(supplierId ? [supplierId] : []), ...(productIds ?? [])];
    const products = this.db.prepare(`SELECT p.id,p.title,p.status FROM products p
      WHERE p.session_id=? AND p.supplier_id IS NOT NULL ${supplierId ? 'AND p.supplier_id=?' : ''} ${productFilter} ORDER BY p.created_at,p.id`)
      .all(...queryParameters) as Array<{ id: string; title: string; status: string }>;
    const reviewRequired = products.filter((product) => product.status === 'needs_review').length;
    const ready = products.filter((product) => ['approved', 'simulated'].includes(product.status));
    let sentProducts = 0;
    let sentGroups = 0;
    let sentImages = 0;
    let skipped = 0;
    let uncertainError: string | undefined;
    const skippedErrors: string[] = [];

    for (const product of ready) {
      signal.throwIfAborted();
      const existing = this.db.prepare('SELECT group_id,status FROM outbound_publications WHERE product_id=? AND session_id=?').all(product.id, this.sessionId) as Array<{ group_id: string; status: string }>;
      const targets = JSON.parse((this.db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(this.sessionId) as { target_group_ids: string }).target_group_ids) as string[];
      const allSubmitted = targets.length > 0 && targets.every((target) => existing.some((entry) => entry.group_id === target && entry.status === 'submitted'));
      if (existing.some((entry) => ['in_progress', 'needs_review'].includes(entry.status)) || allSubmitted) {
        skipped += 1;
        continue;
      }
      try {
        const result = await this.sendApprovedProduct(product.id);
        signal.throwIfAborted();
        sentProducts += 1;
        sentGroups += result.groupCount;
        sentImages += result.imageCount;
      } catch (error) {
        signal.throwIfAborted();
        skipped += 1;
        const detail = error instanceof Error ? error.message : 'No se pudo enviar una referencia.';
        skippedErrors.push(`${product.title || product.id}: ${detail}`);
        if (detail.includes('quedó incierto')) {
          uncertainError = detail;
          break;
        }
        this.logger.warn({ err: error, productId: product.id }, 'Se omitió una referencia durante el envío masivo');
      }
    }
    return { sentProducts, sentGroups, sentImages, reviewRequired, skipped, skippedErrors, ...(uncertainError ? { error: uncertainError } : {}) };
  }

  private tick(): Promise<void> {
    if (this.currentTick) return this.currentTick;
    this.currentTick = this.runTick().finally(() => { this.currentTick = undefined; });
    return this.currentTick;
  }

  private async runTick() {
    try {
      const cutoff = new Date(Date.now() - ASSEMBLY_IDLE_MS).toISOString();
      this.db.prepare("UPDATE whatsapp_product_assemblies SET status='closed' WHERE session_id=? AND status='open' AND last_message_at<=?").run(this.sessionId, cutoff);
      const settled = this.db.prepare(`SELECT p.id,p.raw_text,a.association_confident,a.media_count,a.expected_media_count FROM products p JOIN whatsapp_product_assemblies a ON a.product_id=p.id
        WHERE p.session_id=? AND p.status='needs_review' AND a.session_id=? AND a.status='closed' AND a.last_message_at<=?
        AND NOT EXISTS (SELECT 1 FROM outbound_publications o WHERE o.product_id=p.id AND o.session_id=p.session_id)`).all(this.sessionId, this.sessionId, cutoff) as Array<{ id: string; raw_text: string; association_confident: number; media_count: number; expected_media_count: number | null }>;
      for (const product of settled) {
        if (product.association_confident !== 1 || (product.expected_media_count !== null && product.media_count !== product.expected_media_count)) continue;
        this.approveClearSupplierPrice(product.id, product.raw_text);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Error procesando la cola de distribución');
    }
  }

  private approveClearSupplierPrice(productId: string, rawText: string) {
    const candidates = analyzePrices(rawText).candidates;
    if (candidates.length === 0 || candidates.some((candidate) => candidate.confidence !== 'explicit' || candidate.kind === 'unknown')) return;
    for (const kind of ['price', 'box'] as const) {
      const amounts = new Set(candidates.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.amountCop));
      if (amounts.size > 1) return;
    }
    if ((this.db.prepare('SELECT COUNT(*) as count FROM media_assets WHERE product_id=?').get(productId) as { count: number }).count === 0) return;
    const rule = this.db.prepare('SELECT margin_cop_applied,box_margin_cop_applied FROM products WHERE id=? AND session_id=?').get(productId, this.sessionId) as { margin_cop_applied: number | null; box_margin_cop_applied: number | null } | undefined;
    if (rule?.margin_cop_applied === null || rule?.margin_cop_applied === undefined) return;
    const margins = candidates.map((candidate) => candidate.kind === 'box' ? rule.box_margin_cop_applied : rule.margin_cop_applied);
    if (margins.some((margin) => margin === null)) return;
    const sourcePrices = candidates.map((candidate) => candidate.amountCop);
    const finalPrices = sourcePrices.map((source, index) => addMargin(source, margins[index]!));
    const outputText = prepareOutgoingDescription(replacePriceCandidates(rawText, candidates, finalPrices));
    const primaryIndex = Math.max(0, candidates.findIndex((candidate) => candidate.kind === 'price'));
    const sourcePriceCop = sourcePrices[primaryIndex]!;
    const finalPriceCop = finalPrices[primaryIndex]!;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE products SET source_price_cop=?,final_price_cop=?,output_text=?,status='approved',updated_at=? WHERE id=? AND status='needs_review'")
        .run(sourcePriceCop, finalPriceCop, outputText, now, productId);
      this.db.prepare('INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), 'product.price.prepared.automatically', 'product', productId, JSON.stringify({ sourcePricesCop: sourcePrices, marginsCop: margins, finalPricesCop: finalPrices }), now);
      writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'products', action: 'product.price.prepared.automatically', entityType: 'product', entityId: productId, message: 'Se reconocieron precio y caja y se aplicaron sus márgenes configurados', details: { sourcePricesCop: sourcePrices, marginsCop: margins, finalPricesCop: finalPrices }, createdAt: now });
    })();
  }

  private async enqueueProduct(productId: string, targets: string[]): Promise<number> {
    if (!this.enabled) return 0;
    const product = this.db.prepare('SELECT output_text,status,session_id,supplier_id,raw_text,shoe_code,shoe_code_override,marker_text_applied,image_position FROM products WHERE id=?').get(productId) as { output_text: string | null; status: string; session_id: string; supplier_id: string | null; raw_text: string; shoe_code: string | null; shoe_code_override: number; marker_text_applied: string | null; image_position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | null } | undefined;
    if (!product || product.session_id !== this.sessionId || !product.supplier_id || !['approved', 'simulated'].includes(product.status) || !product.output_text) return 0;
    const shoeCode = product.shoe_code_override === 1 ? product.shoe_code : product.shoe_code ?? extractShoeCode(product.raw_text).code;
    const outgoingText = prepareOutgoingDescription(product.output_text);
    const sources = new Set((this.db.prepare("SELECT source_group_id FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL").all(this.sessionId) as Array<{ source_group_id: string }>).map((row) => row.source_group_id));
    const groups = targets.filter((groupId) => !sources.has(groupId)).map((groupId) => {
      const row = this.db.prepare('SELECT subject FROM whatsapp_groups WHERE session_id=? AND jid=?').get(this.sessionId, groupId) as { subject: string } | undefined;
      return { id: groupId, name: row?.subject ?? groupId };
    });
    if (groups.length === 0) return 0;
    const assets = this.db.prepare('SELECT id,file_name,mime_type,sha256 FROM media_assets WHERE product_id=? ORDER BY position')
      .all(productId) as Array<{ id: string; file_name: string; mime_type: string; sha256: string }>;
    if (assets.length === 0) throw new Error('El producto no tiene fotografías originales.');
    const decisions = assets.map((asset) => ({ asset, decision: readMarkDecision(this.db, asset.id, shoeCode) }));
    const blocked = decisions.find((entry) => entry.decision.status !== 'ready');
    if (blocked) throw new Error(`La fotografía requiere revisión antes de enviarse: ${blocked.decision.reason}`);
    const markedAssets = await Promise.all(assets.map(async (asset) => ({
      asset,
      marked: await saveMarkedImage(this.dataDirectory, readFileSync(join(this.dataDirectory, 'media', asset.file_name)), asset.sha256, {
        code: shoeCode,
        marker: product.marker_text_applied ?? '🌎',
        position: product.image_position ?? 'bottom_right',
        genderIndicator: genderIndicatorFromDescription(product.raw_text),
        ...markOptions(decisions.find((entry) => entry.asset.id === asset.id)!.decision, shoeCode),
      }),
    })));
    let created = 0;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const group of groups) {
        const publicationId = randomUUID();
        const generation = (this.db.prepare('SELECT COALESCE(MAX(generation),0)+1 as next FROM outbound_publications WHERE product_id=? AND group_id=? AND session_id=?').get(productId, group.id, this.sessionId) as { next: number }).next;
        const result = this.db.prepare("INSERT OR IGNORE INTO outbound_publications(id,product_id,group_id,group_name,generation,status,created_at,updated_at,session_id) VALUES (?,?,?,?,?, 'queued',?,?,?)")
          .run(publicationId, productId, group.id, group.name, generation, now, now, this.sessionId);
        if (result.changes === 0) continue;
        for (const [position, entry] of markedAssets.entries()) {
          this.db.prepare("INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,rendered_file_name,rendered_mime_type,caption_snapshot,session_id) VALUES (?,?,?,?,'pending',?,?,?,?)")
            .run(randomUUID(), publicationId, position, entry.asset.id, `derived/${entry.marked.fileName}`, entry.marked.mimeType, position === 0 ? outgoingText : '', this.sessionId);
        }
        created += 1;
      }
      if (created > 0) this.db.prepare('INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), 'product.publication.queued', 'product', productId, JSON.stringify({ targetCount: created }), now);
      if (created > 0) writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'distribution', action: 'product.publication.queued', entityType: 'product', entityId: productId, message: `Se prepararon publicaciones para ${created} grupos`, details: { targetCount: created }, createdAt: now });
    })();
    return created;
  }

  private async sendNextUnit(productId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const unit = this.db.prepare(`SELECT u.id,u.position,u.publication_id,p.product_id,p.group_id,p.group_name,p.status as publication_status,
        COALESCE(u.caption_snapshot,pr.output_text) as output_text,COALESCE(u.rendered_file_name,m.file_name) as file_name,
        COALESCE(u.rendered_mime_type,m.mime_type) as mime_type
      FROM outbound_units u
      JOIN outbound_publications p ON p.id=u.publication_id
      JOIN products pr ON pr.id=p.product_id
      JOIN media_assets m ON m.id=u.media_asset_id
      WHERE u.session_id=? AND p.session_id=? AND u.status='pending' AND p.status IN ('queued','in_progress') AND p.product_id=?
      ORDER BY p.created_at,p.group_id,u.position LIMIT 1`).get(this.sessionId, this.sessionId, productId) as {
        id: string; position: number; publication_id: string; product_id: string; group_id: string; group_name: string; publication_status: string;
        output_text: string; file_name: string; mime_type: string;
      } | undefined;
    if (!unit) return false;
    const pacing = this.db.prepare('SELECT send_interval_ms FROM whatsapp_session_settings WHERE session_id=?').get(this.sessionId) as { send_interval_ms: number } | undefined;
    const intervalMs = pacing?.send_interval_ms ?? 10_000;
    const previousSend = this.db.prepare('SELECT last_send_at FROM session_distribution_control WHERE session_id=?').get(this.sessionId) as { last_send_at: string | null } | undefined;
    if (previousSend?.last_send_at) {
      const elapsedMs = Math.max(0, Date.now() - Date.parse(previousSend.last_send_at));
      const remainingMs = Math.max(0, intervalMs - elapsedMs);
      if (remainingMs > 0) await interruptible(this.delay(remainingMs, signal), signal);
    }
    signal.throwIfAborted();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE outbound_units SET status='transmitting',started_at=?,error=NULL WHERE id=? AND session_id=? AND status='pending'").run(now, unit.id, this.sessionId);
      this.db.prepare("UPDATE outbound_publications SET status='in_progress',updated_at=? WHERE id=?").run(now, unit.publication_id);
      this.db.prepare('UPDATE session_distribution_control SET last_send_at=?,updated_at=? WHERE session_id=?').run(now, now, this.sessionId);
    })();
    try {
      const caption = prepareOutgoingDescription(unit.output_text);
      const result = await interruptible(this.whatsapp.sendImage(unit.group_id, readFileSync(join(this.dataDirectory, 'media', unit.file_name)), unit.mime_type, caption), signal);
      signal.throwIfAborted();
      const completedAt = new Date().toISOString();
      this.db.transaction(() => {
      this.db.prepare("UPDATE outbound_units SET status='submitted',remote_message_id=?,completed_at=? WHERE id=? AND session_id=? AND status='transmitting'").run(result.messageId, completedAt, unit.id, this.sessionId);
      const pending = (this.db.prepare("SELECT COUNT(*) as count FROM outbound_units WHERE publication_id=? AND session_id=? AND status!='submitted'").get(unit.publication_id, this.sessionId) as { count: number }).count;
        if (pending === 0) this.db.prepare("UPDATE outbound_publications SET status='submitted',updated_at=? WHERE id=?").run(completedAt, unit.publication_id);
        writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'distribution', action: 'product.publication.submitted', entityType: 'product', entityId: unit.product_id, message: 'Baileys aceptó una fotografía para el grupo de destino; confirma la entrega en WhatsApp', details: { groupId: unit.group_id, groupName: unit.group_name, imageNumber: unit.position + 1, remoteMessageId: result.messageId }, createdAt: completedAt });
      })();
      this.logger.info({ productId: unit.product_id, groupId: unit.group_id, unitPosition: unit.position }, 'Baileys devolvió el identificador de la unidad publicada');
      return true;
    } catch (error) {
      signal.throwIfAborted();
      const completedAt = new Date().toISOString();
      const detail = error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido durante el envío.';
      this.db.transaction(() => {
      this.db.prepare("UPDATE outbound_units SET status='uncertain',completed_at=?,error=? WHERE id=? AND session_id=? AND status='transmitting'").run(completedAt, detail, unit.id, this.sessionId);
        this.db.prepare("UPDATE outbound_publications SET status='needs_review',updated_at=? WHERE id=?").run(completedAt, unit.publication_id);
        writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'error', category: 'distribution', action: 'product.publication.uncertain', entityType: 'product', entityId: unit.product_id, message: 'El resultado del envío es incierto. Verifica el grupo antes de reintentar', details: { groupId: unit.group_id, groupName: unit.group_name, imageNumber: unit.position + 1, errorType: error instanceof Error ? error.name : 'UnknownError' }, createdAt: completedAt });
      })();
      this.logger.error({ err: error, productId: unit.product_id, groupId: unit.group_id }, 'Publicación incierta; se detuvo el reintento automático para evitar duplicados');
      throw new Error(`El envío quedó incierto. Revisa el grupo antes de reintentar: ${detail}`);
    }
  }
}

export class OutboundDistributionRegistry {
  private readonly services = new Map<string, OutboundDistributionService>();

  constructor(
    private readonly db: AppDatabase,
    private readonly dataDirectory: string,
    private readonly connectorFor: (sessionId: string) => WhatsAppConnector | undefined,
    private readonly logger: FastifyBaseLogger,
    private readonly enabled: boolean,
  ) {}

  get(sessionId: string): OutboundDistributionService | undefined {
    const exists = this.db.prepare('SELECT id FROM whatsapp_sessions WHERE id=? AND archived_at IS NULL').get(sessionId);
    const connector = exists ? this.connectorFor(sessionId) : undefined;
    if (!connector) return undefined;
    let service = this.services.get(sessionId);
    if (!service) {
      service = new OutboundDistributionService(this.db, this.dataDirectory, connector, this.logger, this.enabled, sessionId);
      service.start();
      this.services.set(sessionId, service);
    }
    return service;
  }

  async stop() {
    await Promise.all([...this.services.values()].map((service) => service.stop()));
    this.services.clear();
  }
}
