import Fastify, { LogController, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ApprovalSchema, ProductImageOptionsSchema, ProductUploadSchema, SettingsSchema, SupplierProfileSchema, WhatsAppGroupSelectionSchema, WhatsAppSessionSchema, addMargin, analyzePrices, extractShoeCode, formatCop, prepareOutgoingDescription, replacePriceCandidates } from '@tenis/core';
import type { AppDatabase } from './database.js';
import type { BaileysConnector, BaileysSessionRegistry, WhatsAppConnector } from './whatsapp.js';
import type { OutboundDistributionRegistry, OutboundDistributionService } from './outbound-distribution.js';
import { genderIndicatorFromDescription, saveMarkedImage } from './image-marking.js';
import { LocalImageInspector, type ImageInspection } from './image-inspection.js';
import { ImageInspectionCoordinator } from './image-inspection-coordinator.js';
import { markOptions, readMarkDecision, type MarkMode } from './image-marking-decision.js';
import { writeApplicationLog } from './application-log.js';
import { removeProductImages, removeProducts } from './product-cleanup.js';
import type { SupplierReceptionService } from './supplier-reception.js';
import QRCode from 'qrcode';

class ApprovalError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function planProductApproval(settings: { margin_cop_applied: number | null; box_margin_cop_applied: number | null; raw_text: string }, sourceAmounts: number[] | undefined, description: string) {
  if (settings.margin_cop_applied === null) throw new ApprovalError(409, 'Configura la ganancia de PRECIO del proveedor antes de aprobar el producto.');
  const sourceCandidates = analyzePrices(settings.raw_text).candidates;
  const sourcePrices = sourceAmounts;
  if (!sourcePrices) throw new ApprovalError(400, 'Indica el precio original o los importes originales detectados.');
  if (sourceCandidates.length > 0 && sourceCandidates.length !== sourcePrices.length) throw new ApprovalError(400, 'La cantidad de importes no coincide con los valores detectados en la descripción.');
  if (sourceCandidates.length === 0 && sourcePrices.length !== 1) throw new ApprovalError(400, 'Para esta descripción se espera un solo precio.');
  const margins = sourceCandidates.map((candidate) => candidate.kind === 'box' ? settings.box_margin_cop_applied : settings.margin_cop_applied);
  if (margins.some((margin) => margin === null)) throw new ApprovalError(409, 'Falta configurar el margen de caja para este producto.');
  const finalPrices = sourcePrices.map((source, index) => addMargin(source, margins[index] ?? settings.margin_cop_applied!));
  let outputText = prepareOutgoingDescription(description);
  const outputCandidatesBefore = analyzePrices(outputText).candidates;
  if (sourceCandidates.length > 0 && outputCandidatesBefore.length === sourcePrices.length
    && outputCandidatesBefore.every((candidate, index) => candidate.amountCop === sourcePrices[index])) {
    outputText = replacePriceCandidates(outputText, outputCandidatesBefore, finalPrices);
  }
  const outputPrices = analyzePrices(outputText).candidates;
  if (outputPrices.length !== finalPrices.length || outputPrices.some((candidate, index) => candidate.amountCop !== finalPrices[index])) {
    throw new ApprovalError(400, `El texto debe incluir los importes aprobados: ${finalPrices.map(formatCop).join(' y ')}.`);
  }
  const primaryIndex = Math.max(0, sourceCandidates.findIndex((candidate) => candidate.kind !== 'box'));
  const sourcePriceCop = sourcePrices[primaryIndex]!;
  const finalPrice = finalPrices[primaryIndex]!;
  return { sourcePriceCop, sourcePricesCop: sourcePrices, marginCop: settings.margin_cop_applied, marginsCop: margins, finalPriceCop: finalPrice, finalPricesCop: finalPrices, outputText };
}

const allowedTypes = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);
const TargetSelectionSchema = z.object({ targetGroupIds: z.array(z.string().min(1).max(128)).max(5) });
const SendIntervalSchema = z.object({ sendIntervalMs: z.number().int().min(5_000).max(120_000) });
const ReceptionScheduleSchema = z.object({ startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).refine((value) => value.startTime !== value.endTime, { message: 'El inicio y el fin deben ser distintos.' });

function audit(db: AppDatabase, action: string, type: string, id: string, details: unknown) {
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO audit_events(id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), action, type, id, JSON.stringify(details), createdAt);
  const sessionId = type === 'whatsapp_session' || type === 'distribution' ? id
    : type === 'product' ? (db.prepare('SELECT session_id FROM products WHERE id=?').get(id) as { session_id: string } | undefined)?.session_id ?? 'main'
      : type === 'supplier' ? (db.prepare('SELECT session_id FROM supplier_profiles WHERE id=?').get(id) as { session_id: string } | undefined)?.session_id ?? 'main'
        : 'main';
  const category = type === 'product' ? 'products' : type === 'supplier' ? 'suppliers'
    : type === 'whatsapp_session' ? 'connection' : type === 'distribution' ? 'distribution'
      : type === 'whatsapp' ? 'connection' : 'settings';
  const messages: Record<string, string> = {
    'whatsapp.session.created': 'Se creó una cuenta de WhatsApp',
    'whatsapp.session.renamed': 'Se cambió el nombre de la cuenta',
    'whatsapp.session.connection.requested': 'Se solicitó conectar la cuenta de WhatsApp',
    'whatsapp.session.disconnect.requested': 'Se solicitó desconectar la cuenta de WhatsApp',
    'whatsapp.session.pairing.reset': 'Se reinició la vinculación de esta cuenta',
    'whatsapp.session.connect.failed': 'No se pudo iniciar la conexión de WhatsApp',
    'whatsapp.session.disconnect.failed': 'No se pudo desconectar WhatsApp',
    'whatsapp.session.reset-pairing.failed': 'No se pudo reiniciar la vinculación de WhatsApp',
    'whatsapp.targets.selected': 'Se guardaron los grupos de destino',
    'whatsapp.groups.selected': 'Se guardó la selección de grupos',
    'supplier.created': 'Se agregó un proveedor', 'supplier.updated': 'Se actualizaron las reglas del proveedor',
    'supplier.archived': 'Se archivó un proveedor', 'supplier.restored': 'Se reactivó un proveedor archivado',
    'distribution.started': 'Se inició la distribución', 'distribution.paused': 'Se pausó la distribución',
    'distribution.stopped': 'Se detuvo la distribución', 'settings.updated': 'Se actualizó la configuración',
    'distribution.send_interval.updated': 'Se actualizó la pausa entre envíos',
    'supplier.reception.schedule.updated': 'Se actualizó el rango de recuperación del historial de esta cuenta',
    'product.image_options.updated': 'Se actualizó el código o la posición de la marca',
    'product.image.inspected': 'Se analizaron localmente los códigos y marcas de la fotografía',
    'product.image.inspect.failed': 'No se pudo analizar una fotografía',
    'product.received.manually': 'Se agregó una referencia manualmente',
    'product.approved': 'Se aprobó el precio y la descripción',
    'product.description.updated': 'Se corrigió la descripción que se enviará',
    'product.sent.manually': 'Se solicitó el envío de una referencia',
    'product.send.failed': 'No se pudo completar el envío de la referencia',
    'products.sent.in_bulk': 'Se ejecutó el envío masivo',
    'products.send-all.failed': 'No se pudo iniciar el envío masivo',
    'product.simulated': 'Se registró una simulación local',
  };
  const level = /failed|error|uncertain/i.test(action) ? 'error' : /warning|review/i.test(action) ? 'warning' : 'info';
  writeApplicationLog(db, { sessionId, category, action, entityType: type, entityId: id, message: messages[action] ?? action.replaceAll('.', ' '), details, createdAt, level });
}

function publicProduct(db: AppDatabase, assetsDirectory: string, product: Record<string, unknown>) {
  const assets = db.prepare(`SELECT m.id, m.file_name as fileName, m.mime_type as mimeType, m.size_bytes as sizeBytes, m.position,
      i.ocr_text as ocrText, i.ocr_confidence as ocrConfidence, i.ocr_error as ocrError, i.code_candidates_json as codeCandidatesJson,
      i.detected_code as detectedCode, i.code_confidence as codeConfidence, i.world_variant as worldVariant,
      i.world_confidence as worldConfidence, i.inspected_at as inspectedAt
    FROM media_assets m LEFT JOIN image_inspections i ON i.media_asset_id=m.id WHERE m.product_id=? ORDER BY m.position`)
    .all(product.id as string) as Array<Record<string, unknown>>;
  const publications = db.prepare('SELECT group_id as groupId,group_name as groupName,status,updated_at as updatedAt FROM outbound_publications WHERE product_id=? ORDER BY created_at')
    .all(product.id as string) as Array<Record<string, unknown>>;
  const storedCode = product.shoe_code as string | null;
  const effectiveCode = product.shoe_code_override === 1 ? storedCode : storedCode ?? extractShoeCode(product.raw_text as string).code;
  return {
    ...product,
    shoe_code: effectiveCode,
    // Recompute on read so pending products reflect parser fixes without a data migration.
    analysis: analyzePrices(product.raw_text as string),
    analysis_json: undefined,
    images: assets.map((asset) => ({
      id: asset.id, fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, position: asset.position,
      url: `/api/media/${asset.id}`,
      marking: readMarkDecision(db, asset.id as string, effectiveCode),
      inspection: asset.inspectedAt ? {
        ocrText: asset.ocrText,
        ocrConfidence: asset.ocrConfidence,
        ocrError: asset.ocrError,
        codeCandidates: JSON.parse(String(asset.codeCandidatesJson ?? '[]')),
        detectedCode: asset.detectedCode,
        codeConfidence: asset.codeConfidence,
        world: { detected: Boolean(asset.worldVariant), variant: asset.worldVariant, confidence: asset.worldConfidence },
        inspectedAt: asset.inspectedAt,
      } : null,
    })),
    markedImageUrl: `/api/products/${product.id as string}/preview`,
    sessionId: product.session_id,
    supplierId: product.supplier_id,
    publications,
  };
}

export function createApp(options: { db: AppDatabase; dataDirectory: string; logLevel?: string; port?: number; whatsapp?: WhatsAppConnector; sessionRegistry?: BaileysSessionRegistry; messagingEnabled?: boolean; outboundDistribution?: OutboundDistributionService; distributionRegistry?: OutboundDistributionRegistry; realSendsEnabled?: boolean; imageInspector?: Pick<LocalImageInspector, 'inspect'> & Partial<Pick<LocalImageInspector, 'close'>>; imageInspections?: ImageInspectionCoordinator; supplierReception?: SupplierReceptionService }): FastifyInstance {
  const { db, dataDirectory, logLevel = 'info', port = 3210, whatsapp, sessionRegistry, messagingEnabled = false, outboundDistribution, distributionRegistry, realSendsEnabled = false, supplierReception } = options;
  const mediaDirectory = join(dataDirectory, 'media');
  mkdirSync(mediaDirectory, { recursive: true });
  const imageInspections = options.imageInspections ?? new ImageInspectionCoordinator(db, dataDirectory, options.imageInspector ?? new LocalImageInspector(join(dataDirectory, 'ocr-cache')));
  const app = Fastify({
    logger: { level: logLevel, redact: { paths: ['req.headers.authorization', '*.qr', '*.token', '*.password'], censor: '[REDACTED]' } },
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.register(multipart, { limits: { files: 8, fileSize: 20 * 1024 * 1024, fields: 4 } });
  app.addHook('onClose', async () => { await imageInspections.close(); });

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!host || !allowedHosts.includes(host)) {
      return reply.code(403).send({ error: 'Host no autorizado.' });
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const allowedOrigins = [...allowedHosts, '127.0.0.1:5173', 'localhost:5173'];
        if (!allowedOrigins.includes(parsed.host.toLowerCase())) {
          return reply.code(403).send({ error: 'Origen no autorizado.' });
        }
      } catch {
        return reply.code(403).send({ error: 'Origen no válido.' });
      }
    }
  });

  const connectorFor = (sessionId: string): WhatsAppConnector | undefined => sessionRegistry?.get(sessionId) ?? (sessionId === 'main' ? whatsapp : undefined);
  const distributionFor = (sessionId: string): OutboundDistributionService | undefined => distributionRegistry?.get(sessionId) ?? (sessionId === 'main' ? outboundDistribution : undefined);
  const sessionRow = (id: string) => db.prepare('SELECT id,name FROM whatsapp_sessions WHERE id=? AND archived_at IS NULL').get(id) as { id: string; name: string } | undefined;
  const receptionFor = (sessionId: string) => supplierReception?.snapshot(sessionId) ?? (() => {
    const counts = db.prepare(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pendingCount,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failedCount FROM supplier_inbox_messages WHERE session_id=?`).get(sessionId) as { pendingCount: number | null; failedCount: number | null };
    const state = db.prepare(`SELECT recovery_status as recoveryStatus,recovery_started_at as recoveryStartedAt,recovery_finished_at as recoveryFinishedAt,recovery_message_count as recoveryMessageCount,
      recovery_warning as recoveryWarning,last_supplier_message_at as lastSupplierMessageAt,last_supplier_group_jid as lastSupplierGroupJid,last_supplier_result as lastSupplierResult FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as Record<string, unknown> | undefined;
    return { pendingCount: counts.pendingCount ?? 0, failedCount: counts.failedCount ?? 0, recoveryStatus: state?.recoveryStatus ?? 'idle', recoveryStartedAt: state?.recoveryStartedAt ?? null,
      recoveryFinishedAt: state?.recoveryFinishedAt ?? null, recoveryMessageCount: state?.recoveryMessageCount ?? 0, recoveryWarning: state?.recoveryWarning ?? null,
      lastSupplierMessageAt: state?.lastSupplierMessageAt ?? null, lastSupplierGroupJid: state?.lastSupplierGroupJid ?? null, lastSupplierResult: state?.lastSupplierResult ?? null };
  })();

  app.get('/api/health', async () => ({ ok: true, mode: messagingEnabled ? 'experimental' : 'simulation', connected: Boolean(sessionRegistry?.get('main')?.status().status === 'connected' || whatsapp?.status().status === 'connected'), distribution: distributionFor('main')?.status() ?? 'stopped' }));

  app.get('/api/sessions', async () => {
    const rows = db.prepare('SELECT id,name,created_at as createdAt FROM whatsapp_sessions WHERE archived_at IS NULL ORDER BY created_at').all() as Array<{ id: string; name: string; createdAt: string }>;
    return Promise.all(rows.map(async (row) => {
      const connector = connectorFor(row.id);
      const state = connector?.status() ?? { status: 'disabled' as const, qr: null, lastError: null };
      const selection = db.prepare('SELECT target_group_ids,send_interval_ms,reception_start_time,reception_end_time,reception_timezone FROM whatsapp_session_settings WHERE session_id=?').get(row.id) as { target_group_ids: string; send_interval_ms: number; reception_start_time: string; reception_end_time: string; reception_timezone: string };
      const control = db.prepare('SELECT status FROM session_distribution_control WHERE session_id=?').get(row.id) as { status: string };
      return { ...row, status: state.status, qrDataUrl: state.qr ? await QRCode.toDataURL(state.qr, { width: 260, margin: 1 }) : null, lastError: state.lastError, reception: state.reception ?? null, receptionQueue: receptionFor(row.id), receptionSchedule: { startTime: selection.reception_start_time, endTime: selection.reception_end_time, timeZone: selection.reception_timezone }, targetGroupIds: JSON.parse(selection.target_group_ids) as string[], sendIntervalMs: selection.send_interval_ms, enabled: messagingEnabled, distributionStatus: control.status };
    }));
  });

  app.post('/api/sessions', async (request, reply) => {
    const input = WhatsAppSessionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Cuenta inválida.', details: input.error.flatten() });
    const id = randomUUID(); const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('INSERT INTO whatsapp_sessions(id,name,created_at) VALUES (?,?,?)').run(id, input.data.name, now);
      db.prepare('INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES (? ,\'[]\',?)').run(id, now);
      db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES (?,'stopped',?)").run(id, now);
      audit(db, 'whatsapp.session.created', 'whatsapp_session', id, { name: input.data.name });
    })();
    connectorFor(id); distributionFor(id);
    return reply.code(201).send({ id, name: input.data.name, status: 'disconnected', targetGroupIds: [], enabled: messagingEnabled });
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const connector = connectorFor(account.id);
    const state = connector?.status() ?? { status: 'disabled' as const, qr: null, lastError: null };
    const selection = db.prepare('SELECT target_group_ids,send_interval_ms,reception_start_time,reception_end_time,reception_timezone FROM whatsapp_session_settings WHERE session_id=?').get(account.id) as { target_group_ids: string; send_interval_ms: number; reception_start_time: string; reception_end_time: string; reception_timezone: string };
    const control = db.prepare('SELECT status FROM session_distribution_control WHERE session_id=?').get(account.id) as { status: string };
    return { ...account, status: state.status, qrDataUrl: state.qr ? await QRCode.toDataURL(state.qr, { width: 260, margin: 1 }) : null, lastError: state.lastError, reception: state.reception ?? null, receptionQueue: receptionFor(account.id), receptionSchedule: { startTime: selection.reception_start_time, endTime: selection.reception_end_time, timeZone: selection.reception_timezone }, targetGroupIds: JSON.parse(selection.target_group_ids), sendIntervalMs: selection.send_interval_ms, enabled: messagingEnabled, distributionStatus: control.status };
  });

  app.put<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/reception-schedule', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const input = ReceptionScheduleSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Configura dos horas válidas y diferentes.', details: input.error.flatten() });
    const now = new Date().toISOString();
    db.prepare('UPDATE whatsapp_session_settings SET reception_start_time=?,reception_end_time=?,reception_timezone=?,updated_at=? WHERE session_id=?')
      .run(input.data.startTime, input.data.endTime, 'America/Bogota', now, account.id);
    audit(db, 'supplier.reception.schedule.updated', 'whatsapp_session', account.id, { ...input.data, timeZone: 'America/Bogota' });
    await supplierReception?.scheduleChanged(account.id);
    return { ok: true, receptionSchedule: { ...input.data, timeZone: 'America/Bogota' }, receptionQueue: receptionFor(account.id) };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/reception', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    return receptionFor(account.id);
  });

  app.put<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/send-interval', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const input = SendIntervalSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'El intervalo debe ser de entre 5 y 120 segundos.', details: input.error.flatten() });
    const updatedAt = new Date().toISOString();
    db.prepare('UPDATE whatsapp_session_settings SET send_interval_ms=?,updated_at=? WHERE session_id=?').run(input.data.sendIntervalMs, updatedAt, account.id);
    audit(db, 'distribution.send_interval.updated', 'distribution', account.id, input.data);
    return { ok: true, sendIntervalMs: input.data.sendIntervalMs };
  });

  app.patch<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const input = WhatsAppSessionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Cuenta inválida.', details: input.error.flatten() });
    db.prepare('UPDATE whatsapp_sessions SET name=? WHERE id=?').run(input.data.name, account.id);
    audit(db, 'whatsapp.session.renamed', 'whatsapp_session', account.id, input.data);
    return { ok: true, id: account.id, name: input.data.name };
  });

  for (const operation of ['connect', 'disconnect', 'reset-pairing'] as const) {
    app.post<{ Params: { sessionId: string } }>(`/api/sessions/:sessionId/${operation}`, async (request, reply) => {
      const connector = connectorFor(request.params.sessionId);
      if (!messagingEnabled || !connector) return reply.code(409).send({ error: 'La integración experimental no está habilitada para esta cuenta.' });
      try {
        if (operation === 'connect') await connector.connect();
        if (operation === 'disconnect') await connector.disconnect();
        if (operation === 'reset-pairing') { await connector.resetSession(); await connector.connect(); }
        audit(db, `whatsapp.session.${operation === 'reset-pairing' ? 'pairing.reset' : operation === 'connect' ? 'connection.requested' : 'disconnect.requested'}`, 'whatsapp_session', request.params.sessionId, {});
        return reply.code(operation === 'disconnect' ? 200 : 202).send({ ok: true });
      } catch (error) {
        audit(db, `whatsapp.session.${operation}.failed`, 'whatsapp_session', request.params.sessionId, {});
        return reply.code(503).send({ error: error instanceof Error ? error.message : 'No se pudo completar la operación.' });
      }
    });
  }

  app.get<{ Params: { sessionId: string }; Querystring: { cached?: string } }>('/api/sessions/:sessionId/groups', async (request, reply) => {
    const account = sessionRow(request.params.sessionId); const connector = account && connectorFor(account.id);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const storedGroups = () => db.prepare('SELECT jid as id,subject as name FROM whatsapp_groups WHERE session_id=? ORDER BY subject COLLATE NOCASE').all(account.id);
    const cachedGroups = storedGroups();
    if (request.query.cached === 'true' && cachedGroups.length) return cachedGroups;
    if (!connector) return cachedGroups;
    try {
      if (connector.status().status === 'connected') {
        const groups = await connector.listGroups(); const now = new Date().toISOString();
        const upsert = db.prepare('INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?) ON CONFLICT(session_id,jid) DO UPDATE SET subject=excluded.subject,updated_at=excluded.updated_at');
        db.transaction(() => {
          db.prepare('DELETE FROM whatsapp_groups WHERE session_id=?').run(account.id);
          for (const group of groups) upsert.run(account.id, group.id, group.name, now);
          const active = new Set(groups.map((group) => group.id));
          const selection = db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(account.id) as { target_group_ids: string };
          const targets = (JSON.parse(selection.target_group_ids) as string[]).filter((id) => active.has(id));
          db.prepare('UPDATE whatsapp_session_settings SET target_group_ids=?,updated_at=? WHERE session_id=?').run(JSON.stringify(targets), now, account.id);
        })();
      }
      return storedGroups();
    } catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : 'No se pudieron consultar los grupos.' }); }
  });

  app.put<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/targets', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    const body = TargetSelectionSchema.safeParse(request.body);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    if (!body.success) return reply.code(400).send({ error: 'Destinos inválidos.', details: body.error.flatten() });
    const targets = body.data.targetGroupIds;
    if (new Set(targets).size !== targets.length) return reply.code(400).send({ error: 'Los destinos deben ser únicos.' });
    const selected = targets.length ? db.prepare(`SELECT jid FROM whatsapp_groups WHERE session_id=? AND jid IN (${targets.map(() => '?').join(',')})`).all(account.id, ...targets) : [];
    if (selected.length !== targets.length) return reply.code(400).send({ error: 'Actualiza los grupos y selecciona solo destinos de esta cuenta.' });
    if (targets.some((id) => db.prepare("SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL").get(account.id, id))) return reply.code(400).send({ error: 'Un grupo proveedor no puede ser destino.' });
    const now = new Date().toISOString();
    db.prepare('UPDATE whatsapp_session_settings SET target_group_ids=?,updated_at=? WHERE session_id=?').run(JSON.stringify(targets), now, account.id);
    audit(db, 'whatsapp.targets.selected', 'whatsapp_session', account.id, { targets });
    return { ok: true, targetGroupIds: targets };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/providers', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    return db.prepare(`SELECT p.id,p.session_id as sessionId,p.source_group_id as sourceGroupId,p.name,p.margin_cop as priceMarginCop,p.box_margin_cop as boxMarginCop,p.marker_text as markerText,p.default_position as defaultPosition,g.subject as sourceGroupName
      FROM supplier_profiles p LEFT JOIN whatsapp_groups g ON g.session_id=p.session_id AND g.jid=p.source_group_id WHERE p.session_id=? AND p.archived_at IS NULL ORDER BY p.name COLLATE NOCASE`).all(account.id);
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/providers', async (request, reply) => {
    const account = sessionRow(request.params.sessionId); const input = SupplierProfileSchema.safeParse(request.body);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    if (!input.success) return reply.code(400).send({ error: 'Proveedor inválido.', details: input.error.flatten() });
    const group = db.prepare('SELECT 1 FROM whatsapp_groups WHERE session_id=? AND jid=?').get(account.id, input.data.sourceGroupId);
    if (!group) return reply.code(400).send({ error: 'Actualiza los grupos y selecciona el grupo proveedor de esta cuenta.' });
    if ((JSON.parse((db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(account.id) as { target_group_ids: string }).target_group_ids) as string[]).includes(input.data.sourceGroupId)) return reply.code(400).send({ error: 'Quita el grupo proveedor de los destinos de esta cuenta.' });
    const existing = db.prepare('SELECT id,archived_at FROM supplier_profiles WHERE session_id=? AND source_group_id=?')
      .get(account.id, input.data.sourceGroupId) as { id: string; archived_at: string | null } | undefined;
    if (existing && existing.archived_at === null) return reply.code(409).send({ error: 'Ese grupo ya está registrado como proveedor de esta cuenta. Puedes editar sus reglas en la lista de proveedores activos.', supplierId: existing.id });
    const id = existing?.id ?? randomUUID(); const now = new Date().toISOString();
    db.transaction(() => {
      if (existing) {
        db.prepare('UPDATE supplier_profiles SET name=?,margin_cop=?,box_margin_cop=?,marker_text=?,default_position=?,archived_at=NULL,updated_at=? WHERE id=?')
          .run(input.data.name, input.data.priceMarginCop, input.data.boxMarginCop, input.data.markerText, input.data.defaultPosition, now, id);
      } else {
        db.prepare('INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,box_margin_cop,marker_text,default_position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, account.id, input.data.sourceGroupId, input.data.name, input.data.priceMarginCop, input.data.boxMarginCop, input.data.markerText, input.data.defaultPosition, now, now);
      }
      audit(db, existing ? 'supplier.restored' : 'supplier.created', 'supplier', id, input.data);
    })();
    return reply.code(201).send({ id, sessionId: account.id, ...input.data, restored: Boolean(existing) });
  });

  app.put<{ Params: { supplierId: string } }>('/api/providers/:supplierId', async (request, reply) => {
    const provider = db.prepare('SELECT id,session_id,source_group_id FROM supplier_profiles WHERE id=? AND archived_at IS NULL').get(request.params.supplierId) as { id: string; session_id: string; source_group_id: string } | undefined;
    const input = SupplierProfileSchema.safeParse(request.body);
    if (!provider) return reply.code(404).send({ error: 'Proveedor no encontrado.' });
    if (!input.success) return reply.code(400).send({ error: 'Proveedor inválido.', details: input.error.flatten() });
    if (!db.prepare('SELECT 1 FROM whatsapp_groups WHERE session_id=? AND jid=?').get(provider.session_id, input.data.sourceGroupId)) return reply.code(400).send({ error: 'El grupo proveedor no pertenece a esta cuenta.' });
    const targets = JSON.parse((db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(provider.session_id) as { target_group_ids: string }).target_group_ids) as string[];
    if (targets.includes(input.data.sourceGroupId)) return reply.code(400).send({ error: 'Quita el grupo proveedor de los destinos de esta cuenta.' });
    const conflict = db.prepare('SELECT id,archived_at FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND id<>?')
      .get(provider.session_id, input.data.sourceGroupId, provider.id) as { id: string; archived_at: string | null } | undefined;
    if (conflict) return reply.code(409).send({ error: conflict.archived_at === null
      ? 'Ese grupo ya está registrado como proveedor de esta cuenta. Puedes editar sus reglas en la lista de proveedores activos.'
      : 'Ese grupo tiene un proveedor archivado. Usa Agregar proveedor para reactivarlo.', supplierId: conflict.id });
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE supplier_profiles SET source_group_id=?,name=?,margin_cop=?,box_margin_cop=?,marker_text=?,default_position=?,updated_at=? WHERE id=?')
        .run(input.data.sourceGroupId,input.data.name,input.data.priceMarginCop,input.data.boxMarginCop,input.data.markerText,input.data.defaultPosition,now,provider.id);
      audit(db, 'supplier.updated', 'supplier', provider.id, input.data);
    })();
    return { ok: true, id: provider.id, ...input.data };
  });

  app.delete<{ Params: { supplierId: string } }>('/api/providers/:supplierId', async (request, reply) => {
    const provider = db.prepare('SELECT id,session_id as sessionId,source_group_id as groupId FROM supplier_profiles WHERE id=? AND archived_at IS NULL').get(request.params.supplierId) as { id: string; sessionId: string; groupId: string } | undefined;
    if (!provider) return reply.code(404).send({ error: 'Proveedor no encontrado.' });
    db.prepare('UPDATE supplier_profiles SET archived_at=?,updated_at=? WHERE id=?').run(new Date().toISOString(),new Date().toISOString(),request.params.supplierId);
    supplierReception?.archiveProvider(provider.sessionId, provider.groupId);
    audit(db, 'supplier.archived', 'supplier', request.params.supplierId, {});
    return { ok: true };
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/distribution', async (request) => {
    const sessionId = request.query.sessionId ?? 'main';
    const publications = db.prepare('SELECT status,COUNT(*) as count FROM outbound_publications WHERE session_id=? GROUP BY status').all(sessionId) as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(publications.map((entry) => [entry.status, entry.count]));
    const state = db.prepare('SELECT status FROM session_distribution_control WHERE session_id=?').get(sessionId) as { status: string } | undefined;
    return { realSendsEnabled, connected: connectorFor(sessionId)?.status().status === 'connected', status: state?.status ?? 'stopped', queue: counts };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/distribution/start', async (request, reply) => {
    if (!realSendsEnabled || !distributionFor(request.params.sessionId)) return reply.code(409).send({ error: 'Habilita el envío real y reinicia la aplicación.' });
    if (connectorFor(request.params.sessionId)?.status().status !== 'connected') return reply.code(409).send({ error: 'Conecta WhatsApp antes de iniciar la distribución.' });
    const targets = JSON.parse((db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(request.params.sessionId) as { target_group_ids: string }).target_group_ids) as string[];
    if (targets.length === 0) return reply.code(409).send({ error: 'Configura los destinos para esta cuenta.' });
    const now = new Date().toISOString();
    db.prepare("UPDATE session_distribution_control SET status='running',updated_at=? WHERE session_id=?").run(now,request.params.sessionId);
    audit(db, 'distribution.started', 'whatsapp_session', request.params.sessionId, { targetCount: targets.length });
    return { ok: true, status: 'running' };
  });

  for (const operation of ['pause', 'stop'] as const) {
    app.post<{ Params: { sessionId: string } }>(`/api/sessions/:sessionId/distribution/${operation}`, async (request) => {
      const status = operation === 'pause' ? 'paused' : 'stopped'; const now = new Date().toISOString();
      db.prepare('UPDATE session_distribution_control SET status=?,updated_at=? WHERE session_id=?').run(status,now,request.params.sessionId);
      audit(db, `distribution.${operation === 'pause' ? 'paused' : 'stopped'}`, 'whatsapp_session', request.params.sessionId, {});
      return { ok: true, status };
    });
  }

  // Backward-compatible routes for the migrated primary account.
  app.get('/api/whatsapp', async () => {
    const connector = connectorFor('main'); const state = connector?.status() ?? { status: 'disabled' as const, qr: null, lastError: null };
    const selection = db.prepare('SELECT source_group_id as sourceGroupId FROM whatsapp_settings WHERE id=1').get() as { sourceGroupId: string | null };
    const targets = db.prepare("SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id='main'").get() as { target_group_ids: string };
    return { status: state.status, qrDataUrl: state.qr ? await QRCode.toDataURL(state.qr, { width: 260, margin: 1 }) : null, lastError: state.lastError, reception: state.reception ?? null, sourceGroupId: selection.sourceGroupId, targetGroupIds: JSON.parse(targets.target_group_ids), enabled: messagingEnabled };
  });
  app.post('/api/whatsapp/connect', async (_request, reply) => { const connector = connectorFor('main'); if (!connector || !messagingEnabled) return reply.code(409).send({ error: 'Baileys está deshabilitado.' }); await connector.connect(); return reply.code(202).send({ ok: true }); });
  app.post('/api/whatsapp/disconnect', async () => { await connectorFor('main')?.disconnect(); return { ok: true }; });
  app.post('/api/whatsapp/reset-pairing', async (_request, reply) => { const connector = connectorFor('main'); if (!connector || !messagingEnabled) return reply.code(409).send({ error: 'Baileys está deshabilitado.' }); await connector.resetSession(); await connector.connect(); return reply.code(202).send({ ok: true }); });
  app.get('/api/whatsapp/groups', async (_request, reply) => { const response = await app.inject({ method: 'GET', url: '/api/sessions/main/groups', headers: { host: `127.0.0.1:${port}` } }); if (response.statusCode >= 400) return reply.code(response.statusCode).send(response.json()); return response.json(); });
  app.put('/api/whatsapp/selection', async (request, reply) => {
    const parsed = WhatsAppGroupSelectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Selección inválida.', details: parsed.error.flatten() });
    const groups = new Set((db.prepare('SELECT jid FROM whatsapp_groups WHERE session_id=\'main\'').all() as Array<{ jid: string }>).map((group) => group.jid));
    const selected = [...(parsed.data.sourceGroupId ? [parsed.data.sourceGroupId] : []), ...parsed.data.targetGroupIds];
    if (selected.some((id) => !groups.has(id))) return reply.code(400).send({ error: 'Actualiza los grupos y elige grupos disponibles en esta cuenta.' });
    const now = new Date().toISOString();
    db.prepare('UPDATE whatsapp_session_settings SET target_group_ids=?,updated_at=? WHERE session_id=\'main\'').run(JSON.stringify(parsed.data.targetGroupIds),now);
    db.prepare('UPDATE whatsapp_settings SET source_group_id=?,target_group_ids=?,updated_at=? WHERE id=1').run(parsed.data.sourceGroupId,JSON.stringify(parsed.data.targetGroupIds),now);
    if (parsed.data.sourceGroupId) {
      const existing = db.prepare("SELECT id FROM supplier_profiles WHERE session_id='main' AND archived_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
      const providerName = (db.prepare("SELECT subject FROM whatsapp_groups WHERE session_id='main' AND jid=?").get(parsed.data.sourceGroupId) as { subject: string }).subject;
      if (existing) db.prepare('UPDATE supplier_profiles SET source_group_id=?,name=?,updated_at=? WHERE id=?').run(parsed.data.sourceGroupId,providerName,now,existing.id);
      else db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES (?,'main',?,?,(SELECT margin_cop FROM settings WHERE id=1),'🌎','bottom_right',?,?)")
        .run(randomUUID(),parsed.data.sourceGroupId,providerName,now,now);
    }
    audit(db, 'whatsapp.groups.selected', 'whatsapp', 'main', parsed.data);
    return { ok: true, ...parsed.data };
  });

  app.get('/api/settings', async () => {
    const row = db.prepare('SELECT margin_cop, target_groups FROM settings WHERE id = 1').get() as { margin_cop: number; target_groups: string };
    return { marginCop: row.margin_cop, targetGroups: JSON.parse(row.target_groups) };
  });

  app.put('/api/settings', async (request, reply) => {
    const parsed = SettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Configuración inválida.', details: parsed.error.flatten() });
    const duplicate = new Set(parsed.data.targetGroups.map((group) => group.id)).size !== parsed.data.targetGroups.length;
    if (duplicate) return reply.code(400).send({ error: 'Los grupos de destino deben ser distintos.' });
    db.prepare('UPDATE settings SET margin_cop = ?, target_groups = ?, updated_at = ? WHERE id = 1')
      .run(parsed.data.marginCop, JSON.stringify(parsed.data.targetGroups), new Date().toISOString());
    audit(db, 'settings.updated', 'settings', '1', parsed.data);
    return parsed.data;
  });

  app.get<{ Querystring: { sessionId?: string; supplierId?: string } }>('/api/products', async (request) => {
    const sessionId = request.query.sessionId ?? 'main';
    const products = db.prepare(`SELECT p.*,sp.name as supplier_name,ws.name as session_name FROM products p
      LEFT JOIN supplier_profiles sp ON sp.id=p.supplier_id
      JOIN whatsapp_sessions ws ON ws.id=p.session_id
      WHERE p.session_id=? ${request.query.supplierId ? 'AND p.supplier_id=?' : ''}
      ORDER BY p.created_at DESC LIMIT 500`).all(...(request.query.supplierId ? [sessionId, request.query.supplierId] : [sessionId])) as Array<Record<string, unknown>>;
    return products.map((product) => publicProduct(db, mediaDirectory, product));
  });

  app.delete<{ Params: { id: string } }>('/api/products/:id', async (request, reply) => {
    const product = db.prepare('SELECT id,session_id,title FROM products WHERE id=?').get(request.params.id) as { id: string; session_id: string; title: string } | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    const canDelete = db.prepare(`SELECT 1 FROM outbound_publications p WHERE p.product_id=? AND p.status='submitted'
      AND NOT EXISTS (SELECT 1 FROM outbound_publications active WHERE active.product_id=p.product_id AND active.status IN ('queued','in_progress','needs_review'))
      AND NOT EXISTS (SELECT 1 FROM outbound_units u JOIN outbound_publications up ON up.id=u.publication_id
        WHERE up.product_id=p.product_id AND u.status IN ('pending','transmitting','uncertain')) LIMIT 1`).get(product.id);
    if (!canDelete) return reply.code(409).send({ error: 'Solo puedes eliminar productos enviados y sin publicaciones pendientes o inciertas.' });
    const result = removeProducts(db, dataDirectory, [product], 'products.deleted.manually', 'Se eliminó un producto enviado del catálogo');
    return { ok: true, ...result };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/photos', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const input = z.object({ imageIds: z.array(z.string().min(1).max(128)).min(1).max(5000)
      .refine((ids) => new Set(ids).size === ids.length) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Selecciona una o más fotos distintas para eliminar.' });
    const assets: Array<{ product_id: string }> = [];
    for (let offset = 0; offset < input.data.imageIds.length; offset += 500) {
      const ids = input.data.imageIds.slice(offset, offset + 500);
      assets.push(...db.prepare(`SELECT m.product_id FROM media_assets m JOIN products p ON p.id=m.product_id
        WHERE p.session_id=? AND m.id IN (${ids.map(() => '?').join(',')})`).all(account.id, ...ids) as Array<{ product_id: string }>);
    }
    if (assets.length !== input.data.imageIds.length) return reply.code(400).send({ error: 'Una o más fotos ya no existen o no pertenecen a esta cuenta. Actualiza la selección.' });
    const cleanup = () => removeProductImages(db, dataDirectory, account.id, input.data.imageIds);
    try {
      const distribution = distributionFor(account.id);
      const result = distribution ? await distribution.cancelProductsAndRun([...new Set(assets.map((asset) => asset.product_id))], cleanup) : cleanup();
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'No se pudieron eliminar las fotos seleccionadas.' });
    }
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/products', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const distribution = distributionFor(account.id);
    db.prepare("UPDATE session_distribution_control SET status='stopped',updated_at=? WHERE session_id=?").run(new Date().toISOString(), account.id);
    const cleanup = () => {
      const products = db.prepare('SELECT id,session_id,title FROM products WHERE session_id=?').all(account.id) as Array<{ id: string; session_id: string; title: string }>;
      return removeProducts(db, dataDirectory, products, 'products.deleted.manually', 'Se detuvieron los envíos y se eliminaron todos los productos del catálogo de la cuenta');
    };
    try {
      const result = distribution ? await distribution.cancelSendsAndRun(cleanup) : cleanup();
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'No se pudieron eliminar los productos.' });
    }
  });

  app.delete<{ Params: { sessionId: string }; Body: { supplierId?: string | null } }>('/api/sessions/:sessionId/products/sent', async (request, reply) => {
    const account = sessionRow(request.params.sessionId);
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const input = z.object({ supplierId: z.string().min(1).nullable().optional() }).safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: 'Filtro de proveedor inválido.' });
    const supplierId = input.data.supplierId ?? null;
    if (supplierId && !db.prepare('SELECT 1 FROM supplier_profiles WHERE id=? AND session_id=?').get(supplierId, account.id)) {
      return reply.code(400).send({ error: 'El proveedor no pertenece a la cuenta seleccionada.' });
    }
    const filter = supplierId ? 'AND p.supplier_id=?' : '';
    const matched = db.prepare(`SELECT COUNT(*) as count FROM products p WHERE p.session_id=? ${filter}
      AND EXISTS (SELECT 1 FROM outbound_publications sent WHERE sent.product_id=p.id AND sent.status='submitted')`)
      .get(...(supplierId ? [account.id, supplierId] : [account.id])) as { count: number };
    const deletable = db.prepare(`SELECT p.id,p.session_id,p.title FROM products p WHERE p.session_id=? ${filter}
      AND EXISTS (SELECT 1 FROM outbound_publications sent WHERE sent.product_id=p.id AND sent.status='submitted')
      AND NOT EXISTS (SELECT 1 FROM outbound_publications active WHERE active.product_id=p.id AND active.status IN ('queued','in_progress','needs_review'))
      AND NOT EXISTS (SELECT 1 FROM outbound_units u JOIN outbound_publications up ON up.id=u.publication_id
        WHERE up.product_id=p.id AND u.status IN ('pending','transmitting','uncertain')) ORDER BY p.created_at`)
      .all(...(supplierId ? [account.id, supplierId] : [account.id])) as Array<{ id: string; session_id: string; title: string }>;
    const result = removeProducts(db, dataDirectory, deletable, 'products.deleted.manually', 'Se eliminaron productos enviados del catálogo');
    return { ok: true, ...result, skippedUncertainOrInProgress: matched.count - deletable.length };
  });

  app.post<{ Params: { id: string } }>('/api/products/:id/inspect-image', async (request, reply) => {
    const product = db.prepare('SELECT id,session_id FROM products WHERE id=?').get(request.params.id) as { id: string; session_id: string } | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    const assets = db.prepare('SELECT id FROM media_assets WHERE product_id=? ORDER BY position').all(product.id) as Array<{ id: string }>;
    if (assets.length === 0) return reply.code(409).send({ error: 'Este producto no tiene fotografías para analizar.' });

    const results: Array<{ assetId: string; inspection: ImageInspection }> = [];
    const errors: Array<{ assetId: string; message: string }> = [];
    for (const asset of assets) {
      await imageInspections.schedule(asset.id, true);
      const row = db.prepare(`SELECT i.ocr_text,i.ocr_confidence,i.ocr_error,i.code_candidates_json,i.detected_code,i.code_confidence,i.world_variant,i.world_confidence,
        s.status,s.error,s.regions_json FROM image_marking_state s LEFT JOIN image_inspections i ON i.media_asset_id=s.media_asset_id WHERE s.media_asset_id=?`).get(asset.id) as {
        ocr_text: string | null; ocr_confidence: number | null; ocr_error: string | null; code_candidates_json: string | null; detected_code: string | null;
        code_confidence: number | null; world_variant: string | null; world_confidence: number | null; status: string; error: string | null; regions_json: string;
      };
      if (row.status === 'failed') { errors.push({ assetId: asset.id, message: row.error ?? 'No se pudo analizar la fotografía.' }); continue; }
      results.push({ assetId: asset.id, inspection: {
        ocrText: row.ocr_text ?? '', ocrConfidence: row.ocr_confidence ?? 0, ocrError: row.ocr_error,
        codeCandidates: JSON.parse(row.code_candidates_json ?? '[]') as ImageInspection['codeCandidates'], detectedCode: row.detected_code,
        detectedCodeConfidence: row.code_confidence ?? 0, world: { detected: Boolean(row.world_variant), variant: row.world_variant, confidence: row.world_confidence ?? 0, bounds: null },
        regions: JSON.parse(row.regions_json) as NonNullable<ImageInspection['regions']>,
      } });
    }
    const ocrFailures = results.filter((entry) => entry.inspection.ocrError).length;
    audit(db, errors.length || ocrFailures ? 'product.image.inspect.failed' : 'product.image.inspected', 'product', product.id, {
      inspectedImages: results.length,
      codeCandidates: results.reduce((count, entry) => count + entry.inspection.codeCandidates.length, 0),
      worldMarks: results.filter((entry) => entry.inspection.world.detected).length,
      failedImages: errors.length,
      ocrFailures,
    });
    return { inspections: results, errors };
  });

  app.get<{ Params: { id: string }; Querystring: { assetId?: string } }>('/api/products/:id/preview', async (request, reply) => {
    const product = db.prepare(`SELECT p.id,p.shoe_code,p.shoe_code_override,p.marker_text_applied,p.image_position,p.raw_text,p.session_id,p.supplier_id,
        sp.marker_text,sp.default_position,m.id as asset_id,m.file_name,m.mime_type,m.sha256
      FROM products p LEFT JOIN supplier_profiles sp ON sp.id=p.supplier_id JOIN media_assets m ON m.product_id=p.id
      WHERE p.id=? ${request.query.assetId ? 'AND m.id=?' : ''} ORDER BY m.position LIMIT 1`).get(...(request.query.assetId ? [request.params.id, request.query.assetId] : [request.params.id])) as { id: string; shoe_code: string | null; shoe_code_override: number; marker_text_applied: string | null; image_position: 'top_left'|'top_right'|'bottom_left'|'bottom_right'|null; raw_text: string; session_id: string; supplier_id: string; marker_text: string; default_position: 'top_left'|'top_right'|'bottom_left'|'bottom_right'; asset_id: string; file_name: string; mime_type: string; sha256: string } | undefined;
    if (!product) return reply.code(404).send({ error: 'Vista previa no disponible.' });
    const extracted = extractShoeCode(product.raw_text);
    const code = product.shoe_code_override === 1 ? product.shoe_code : product.shoe_code ?? extracted.code;
    const decision = readMarkDecision(db, product.asset_id, code);
    if (decision.status !== 'ready') {
      reply.type(product.mime_type).header('Cache-Control', 'private, no-cache');
      return reply.send(createReadStream(join(mediaDirectory, product.file_name)));
    }
    const marked = await saveMarkedImage(dataDirectory, readFileSync(join(mediaDirectory, product.file_name)), product.sha256, {
      code, marker: product.marker_text_applied ?? product.marker_text ?? '🌎', position: product.image_position ?? product.default_position ?? 'bottom_right',
      genderIndicator: genderIndicatorFromDescription(product.raw_text),
      ...markOptions(decision, code),
    });
    reply.type(marked.mimeType).header('Cache-Control', 'private, no-cache');
    return reply.send(createReadStream(marked.path));
  });

  app.put<{ Params: { id: string } }>('/api/products/:id/image-options', async (request, reply) => {
    const product = db.prepare('SELECT id,session_id FROM products WHERE id=?').get(request.params.id) as { id: string; session_id: string } | undefined;
    const input = ProductImageOptionsSchema.safeParse(request.body);
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    if (!input.success) return reply.code(400).send({ error: 'Código o posición inválidos.', details: input.error.flatten() });
    const publication = db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(product.id);
    if (publication) return reply.code(409).send({ error: 'La imagen de este producto ya está en distribución o requiere conciliar un envío.' });
    db.transaction(() => {
      db.prepare('UPDATE products SET shoe_code=?,shoe_code_override=1,image_position=?,updated_at=? WHERE id=?').run(input.data.shoeCode || null,input.data.position,new Date().toISOString(),product.id);
    })();
    audit(db, 'product.image_options.updated', 'product', product.id, input.data);
    return { ok: true, ...input.data, previewUrl: `/api/products/${product.id}/preview?v=${Date.now()}` };
  });

  app.put<{ Params: { id: string; assetId: string } }>('/api/products/:id/images/:assetId/marking', async (request, reply) => {
    const input = z.object({ mode: z.enum(['automatic','original','mark_all','mark_code','mark_world']) }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Decisión de fotografía inválida.' });
    const asset = db.prepare('SELECT m.id,p.id as product_id,p.shoe_code,p.shoe_code_override,p.raw_text FROM media_assets m JOIN products p ON p.id=m.product_id WHERE m.id=? AND p.id=?')
      .get(request.params.assetId, request.params.id) as { id: string; product_id: string; shoe_code: string | null; shoe_code_override: number; raw_text: string } | undefined;
    if (!asset) return reply.code(404).send({ error: 'Fotografía no encontrada en este producto.' });
    const currentCode = asset.shoe_code_override === 1 ? asset.shoe_code : asset.shoe_code ?? extractShoeCode(asset.raw_text).code;
    if (['mark_code', 'mark_all'].includes(input.data.mode) && !currentCode) return reply.code(400).send({ error: 'Indica y guarda un código antes de añadir código o código y mundo.' });
    if (db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(asset.product_id))
      return reply.code(409).send({ error: 'La fotografía ya participa en una publicación. No puede modificarse ahora.' });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,error,updated_at) VALUES (?,'pending','[]',?,NULL,?)
      ON CONFLICT(media_asset_id) DO UPDATE SET manual_mode=excluded.manual_mode,updated_at=excluded.updated_at`).run(asset.id, input.data.mode === 'automatic' ? null : input.data.mode, now);
    audit(db, 'product.image.marking.confirmed', 'product', asset.product_id, { assetId: asset.id, mode: input.data.mode });
    return { ok: true, marking: readMarkDecision(db, asset.id, currentCode) };
  });

  app.post('/api/products', async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: 'Envía el producto como formulario multipart.' });
    let rawText = '';
    let title = '';
    const temporary: Array<{ path: string; sha256: string; mime: string; size: number; extension: string }> = [];
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'rawText' && typeof part.value === 'string') rawText = part.value;
          if (part.fieldname === 'title' && typeof part.value === 'string') title = part.value;
          continue;
        }
        const extension = allowedTypes.get(part.mimetype);
        if (!extension) throw new Error(`Formato de imagen no admitido: ${part.mimetype}`);
        const path = join(dataDirectory, 'tmp', `${randomUUID()}.upload`);
        mkdirSync(join(dataDirectory, 'tmp'), { recursive: true });
        const hash = createHash('sha256');
        let size = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(part.file, meter, createWriteStream(path, { flags: 'wx' }));
        if (part.file.truncated) throw new Error('La imagen supera el límite de 20 MiB.');
        if (size === 0) throw new Error('La imagen está vacía.');
        const header = new Uint8Array(12);
        const readStream = createReadStream(path);
        let bytesRead = 0;
        for await (const chunk of readStream) {
          const bytes = chunk as Buffer;
          const count = Math.min(bytes.length, header.length - bytesRead);
          header.set(bytes.subarray(0, count), bytesRead);
          bytesRead += count;
          if (bytesRead === header.length) break;
        }
        const signatureMatches = part.mimetype === 'image/jpeg'
          ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
          : part.mimetype === 'image/png'
            ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => header[index] === byte)
            : part.mimetype === 'image/gif'
              ? String.fromCharCode(...header.subarray(0, 6)).startsWith('GIF8')
              : header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 && String.fromCharCode(...header.subarray(8, 12)) === 'WEBP';
        if (!signatureMatches) { rmSync(path, { force: true }); throw new Error('El contenido del archivo no coincide con su tipo de imagen.'); }
        temporary.push({ path, sha256: hash.digest('hex'), mime: part.mimetype, size, extension });
      }
      const fields = ProductUploadSchema.safeParse({ rawText, title });
      if (!fields.success) {
        for (const asset of temporary) rmSync(asset.path, { force: true });
        return reply.code(400).send({ error: 'Producto inválido.', details: fields.error.flatten() });
      }
      if (temporary.length === 0) return reply.code(400).send({ error: 'Adjunta al menos una fotografía original.' });

      const id = randomUUID();
      const now = new Date().toISOString();
      const analysis = analyzePrices(fields.data.rawText);
      const name = fields.data.title ?? fields.data.rawText.split(/\r?\n/)[0]?.slice(0, 160) ?? '';
      const insertProduct = db.prepare('INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
      const insertAsset = db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,?,?)');
      db.transaction(() => {
        insertProduct.run(id, name, fields.data.rawText, JSON.stringify(analysis), 'needs_review', now, now);
        for (const [position, asset] of temporary.entries()) {
          const assetId = randomUUID();
          const fileName = `${asset.sha256}${asset.extension}`;
          const finalPath = join(mediaDirectory, fileName);
          try { renameSync(asset.path, finalPath); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            rmSync(asset.path, { force: true });
          }
          insertAsset.run(assetId, id, asset.sha256, fileName, asset.mime, asset.size, position, now);
        }
        audit(db, 'product.received.manually', 'product', id, { imageCount: temporary.length });
      })();
      for (const asset of db.prepare('SELECT id FROM media_assets WHERE product_id=?').all(id) as Array<{ id: string }>) void imageInspections.schedule(asset.id);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>;
      return reply.code(201).send(publicProduct(db, mediaDirectory, product));
    } catch (error) {
      for (const asset of temporary) rmSync(asset.path, { force: true });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'No se pudo guardar el producto.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/media/:id', async (request, reply) => {
    const asset = db.prepare('SELECT file_name, mime_type FROM media_assets WHERE id = ?').get(request.params.id) as { file_name: string; mime_type: string } | undefined;
    if (!asset) return reply.code(404).send({ error: 'Imagen no encontrada.' });
    const filePath = resolve(mediaDirectory, asset.file_name);
    if (dirname(filePath) !== resolve(mediaDirectory)) return reply.code(400).send({ error: 'Ruta inválida.' });
    reply.type(asset.mime_type).header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(filePath));
  });

  app.post<{ Params: { id: string } }>('/api/products/:id/approve', async (request, reply) => {
    const input = ApprovalSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Aprobación inválida.', details: input.error.flatten() });
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(request.params.id) as Record<string, unknown> | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    if (product.status !== 'needs_review') return reply.code(409).send({ error: 'El producto ya se revisó.' });
    if (db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(request.params.id)) return reply.code(409).send({ error: 'Este producto ya participa en una publicación.' });
    const settings = db.prepare('SELECT margin_cop_applied,box_margin_cop_applied,raw_text FROM products WHERE id=?').get(request.params.id) as { margin_cop_applied: number | null; box_margin_cop_applied: number | null; raw_text: string };
    let plan: ReturnType<typeof planProductApproval>;
    try { plan = planProductApproval(settings, input.data.sourcePricesCop ?? (input.data.sourcePriceCop === undefined ? undefined : [input.data.sourcePriceCop]), input.data.outputText); }
    catch (error) { if (error instanceof ApprovalError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
    const { sourcePriceCop, finalPriceCop: finalPrice, outputText, sourcePricesCop: sourcePrices, finalPricesCop: finalPrices, marginsCop: margins } = plan;
    db.transaction(() => {
      db.prepare('UPDATE products SET source_price_cop=?, final_price_cop=?, output_text=?, status=?, updated_at=? WHERE id=?')
        .run(sourcePriceCop, finalPrice, outputText, 'approved', new Date().toISOString(), request.params.id);
      audit(db, 'product.approved', 'product', request.params.id, { sourcePricesCop: sourcePrices, finalPricesCop: finalPrices, marginsCop: margins });
    })();
    return { ok: true, ...plan };
  });

  app.post('/api/products/approve-all', async (request, reply) => {
    const input = z.object({
      sessionId: z.string().min(1),
      supplierId: z.string().min(1).nullable().optional(),
      products: z.array(z.object({
        id: z.string().min(1),
        sourcePricesCop: z.array(z.number().int().positive().max(1000000)).min(1).max(20).optional(),
        outputText: z.string().trim().min(1).max(12000).optional(),
        reviewMode: z.enum(['original', 'mark_code', 'mark_world', 'mark_all']),
      })).min(1).max(1000).refine((items) => new Set(items.map((item) => item.id)).size === items.length),
    }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Revisa los precios y las decisiones de las fotos del lote.', details: input.error.flatten() });
    const plans: Array<{ id: string; approval: ReturnType<typeof planProductApproval> | null; images: string[]; mode: MarkMode }> = [];
    const errors: string[] = [];
    for (const item of input.data.products) {
      const product = db.prepare('SELECT id,title,status,session_id,supplier_id,raw_text,shoe_code,shoe_code_override,margin_cop_applied,box_margin_cop_applied FROM products WHERE id=?').get(item.id) as {
        id: string; title: string; status: string; session_id: string; supplier_id: string | null; raw_text: string; shoe_code: string | null; shoe_code_override: number; margin_cop_applied: number | null; box_margin_cop_applied: number | null;
      } | undefined;
      try {
        if (!product || product.session_id !== input.data.sessionId || (input.data.supplierId && product.supplier_id !== input.data.supplierId)) throw new Error('No pertenece a esta cuenta o proveedor.');
        if (db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(item.id)) throw new Error('Ya participa en una publicación; revisa o concilia el envío.');
        const assets = db.prepare('SELECT id FROM media_assets WHERE product_id=?').all(item.id) as Array<{ id: string }>;
        if (!assets.length) throw new Error('Falta la fotografía original.');
        const code = product.shoe_code_override === 1 ? product.shoe_code : product.shoe_code ?? extractShoeCode(product.raw_text).code;
        const images = assets.filter((asset) => readMarkDecision(db, asset.id, code).status !== 'ready').map((asset) => asset.id);
        if (images.length && ['mark_code', 'mark_all'].includes(item.reviewMode) && !code) throw new Error('Indica el código o elige agregar solo mundo / conservar original.');
        if (product.margin_cop_applied === null) throw new Error('Configura el margen de PRECIO del proveedor.');
        if (analyzePrices(product.raw_text).candidates.some((candidate) => candidate.kind === 'box') && product.box_margin_cop_applied === null) throw new Error('Configura el margen de CAJA del proveedor.');
        const approval = product.status === 'needs_review' ? planProductApproval(product, item.sourcePricesCop, item.outputText ?? '') : null;
        plans.push({ id: item.id, approval, images, mode: item.reviewMode });
      } catch (error) { errors.push(`${product?.title || item.id}: ${error instanceof Error ? error.message : 'No se pudo aprobar.'}`); }
    }
    if (errors.length) return reply.code(409).send({ error: `No se aprobó el lote. Corrige: ${errors.join(' | ')}`, errors });
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const plan of plans) {
        if (plan.approval) {
          db.prepare("UPDATE products SET source_price_cop=?,final_price_cop=?,output_text=?,status='approved',updated_at=? WHERE id=?")
            .run(plan.approval.sourcePriceCop, plan.approval.finalPriceCop, plan.approval.outputText, now, plan.id);
          audit(db, 'product.approved', 'product', plan.id, { bulk: true, sourcePricesCop: plan.approval.sourcePricesCop, finalPricesCop: plan.approval.finalPricesCop });
        }
        for (const assetId of plan.images) {
          db.prepare(`INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,updated_at) VALUES (?,'pending','[]',?,?)
            ON CONFLICT(media_asset_id) DO UPDATE SET manual_mode=excluded.manual_mode,updated_at=excluded.updated_at`).run(assetId, plan.mode, now);
          audit(db, 'product.image.marking.confirmed', 'product', plan.id, { bulk: true, assetId, mode: plan.mode });
        }
      }
    })();
    return { ok: true, productCount: plans.length, approvedCount: plans.filter((plan) => plan.approval).length, resolvedImages: plans.reduce((count, plan) => count + plan.images.length, 0) };
  });

  app.put<{ Params: { id: string } }>('/api/products/:id/description', async (request, reply) => {
    const input = z.object({ outputText: z.string().trim().min(1).max(12000) }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Escribe una descripción de hasta 12.000 caracteres.' });
    const product = db.prepare('SELECT status,output_text,final_price_cop FROM products WHERE id=?').get(request.params.id) as { status: string; output_text: string | null; final_price_cop: number | null } | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    if (!['approved', 'simulated'].includes(product.status)) return reply.code(409).send({ error: 'Aprueba primero el precio y el texto de este producto.' });
    if (db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(request.params.id)) {
      return reply.code(409).send({ error: 'La descripción ya participa en una publicación. No puede modificarse ahora.' });
    }
    const outputText = prepareOutgoingDescription(input.data.outputText);
    const expected = analyzePrices(prepareOutgoingDescription(product.output_text ?? '')).candidates.map((candidate) => candidate.amountCop);
    if (!expected.length && product.final_price_cop) expected.push(product.final_price_cop);
    const actual = analyzePrices(outputText).candidates;
    if (!expected.length || actual.length !== expected.length || actual.some((candidate, index) => candidate.amountCop !== expected[index])) {
      return reply.code(400).send({ error: `Conserva los importes aprobados en la descripción: ${expected.map(formatCop).join(' y ')}.` });
    }
    db.transaction(() => {
      db.prepare('UPDATE products SET output_text=?,updated_at=? WHERE id=?').run(outputText, new Date().toISOString(), request.params.id);
      audit(db, 'product.description.updated', 'product', request.params.id, {});
    })();
    return { ok: true, outputText };
  });

  app.post<{ Params: { id: string } }>('/api/products/:id/send', async (request, reply) => {
    const product = db.prepare('SELECT session_id FROM products WHERE id=?').get(request.params.id) as { session_id: string } | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    const distribution = distributionFor(product.session_id);
    if (!realSendsEnabled || !distribution) return reply.code(409).send({ error: 'El envío real no está habilitado. Revisa APP_MODE=experimental, WHATSAPP_ENABLED=true y WHATSAPP_SEND_ENABLED=true, y reinicia la aplicación.' });
    try {
      const result = await distribution.sendApprovedProduct(request.params.id);
      audit(db, 'product.sent.manually', 'product', request.params.id, result);
      return { ok: true, ...result, message: `Envío solicitado a ${result.groupCount} grupos con ${result.imageCount} fotos por grupo. Baileys confirmó el envío al servidor; revisa WhatsApp para confirmar la entrega.` };
    } catch (error) {
      audit(db, 'product.send.failed', 'product', request.params.id, {});
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'No se pudo enviar el producto.' });
    }
  });

  app.post('/api/products/send-all', async (request, reply) => {
    const body = z.object({ sessionId: z.string().min(1).default('main'), supplierId: z.string().nullable().optional(), productIds: z.array(z.string().min(1).max(128)).min(1).max(100).optional().refine((ids) => !ids || new Set(ids).size === ids.length, 'La selección no puede repetir productos.') }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Cuenta o proveedor inválido.' });
    const distribution = distributionFor(body.data.sessionId);
    if (!realSendsEnabled || !distribution) return reply.code(409).send({ error: 'El envío real no está habilitado para esta cuenta.' });
    try {
      const result = await distribution.approveAndSendAll(body.data.supplierId ?? undefined, body.data.productIds);
      audit(db, body.data.productIds ? 'products.sent.selected' : 'products.sent.in_bulk', 'distribution', body.data.sessionId, { ...result, supplierId: body.data.supplierId ?? null, productIds: body.data.productIds ?? null });
      const message = result.error
        ? `Se completaron ${result.sentProducts} referencias (${result.sentImages} envíos de fotos). El lote se detuvo porque una publicación quedó incierta: ${result.error} ${result.reviewRequired} referencias siguen por revisar.`
        : `Listo: ${result.sentProducts} referencias enviadas; se procesaron ${result.sentImages} envíos de fotos a ${result.sentGroups} destinos. ${result.reviewRequired} referencias ambiguas siguen por revisar; ${result.skipped} se omitieron.${result.skippedErrors.length ? ` Primeros errores: ${result.skippedErrors.slice(0,3).join(' | ')}` : ''}`;
      return { ok: true, ...result, message };
    } catch (error) {
      audit(db, 'products.send-all.failed', 'distribution', body.data.sessionId, {});
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'No se pudo iniciar el envío masivo.' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/products/:id/simulate', async (request, reply) => {
    const product = db.prepare('SELECT status FROM products WHERE id = ?').get(request.params.id) as { status: string } | undefined;
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado.' });
    if (product.status !== 'approved') return reply.code(409).send({ error: 'Revisa el producto antes de ponerlo en cola.' });
    const settings = db.prepare('SELECT target_groups FROM settings WHERE id = 1').get() as { target_groups: string };
    const groups = SettingsSchema.shape.targetGroups.parse(JSON.parse(settings.target_groups));
    if (groups.length === 0) return reply.code(409).send({ error: 'Configura al menos un grupo de destino de prueba.' });
    db.transaction(() => {
      const insert = db.prepare(`INSERT OR IGNORE INTO deliveries(id,product_id,group_id,group_name,mode,status,created_at) VALUES (?,?,?,?, 'simulation','simulated',?)`);
      for (const group of groups) insert.run(randomUUID(), request.params.id, group.id, group.name, new Date().toISOString());
      audit(db, 'product.simulated', 'product', request.params.id, { groupIds: groups.map((group) => group.id) });
    })();
    return { ok: true, mode: 'simulation', groupCount: groups.length, message: 'Resultado local simulado; no se enviaron mensajes.' };
  });

  app.get<{ Querystring: { sessionId?: string; limit?: string } }>('/api/logs', async (request, reply) => {
    const sessionId = request.query.sessionId ?? 'main';
    if (!sessionRow(sessionId)) return reply.code(404).send({ error: 'Cuenta no encontrada.' });
    const requestedLimit = Number(request.query.limit ?? 200);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) return reply.code(400).send({ error: 'El límite debe estar entre 1 y 500.' });
    const rows = db.prepare(`SELECT l.id,l.session_id as sessionId,s.name as sessionName,l.level,
        CASE WHEN l.entity_type='whatsapp' THEN 'connection' ELSE l.category END as category,
        l.action,l.entity_type as entityType,l.entity_id as entityId,l.message,l.details_json as detailsJson,l.created_at as createdAt,
        CASE l.entity_type WHEN 'product' THEN p.title WHEN 'supplier' THEN sp.name WHEN 'whatsapp_session' THEN s.name
          WHEN 'whatsapp_group' THEN (SELECT g.subject FROM whatsapp_groups g WHERE g.session_id=l.session_id AND g.jid=l.entity_id)
          ELSE NULL END as entityName
      FROM application_logs l JOIN whatsapp_sessions s ON s.id=l.session_id
      LEFT JOIN products p ON l.entity_type='product' AND p.id=l.entity_id
      LEFT JOIN supplier_profiles sp ON l.entity_type='supplier' AND sp.id=l.entity_id
      WHERE l.session_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT ?`).all(sessionId, requestedLimit) as Array<Record<string, unknown> & { detailsJson: string }>;
    return rows.map(({ detailsJson, ...row }) => ({ ...row, details: JSON.parse(detailsJson) as unknown }));
  });
  app.get('/api/deliveries', async () => db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT 500').all());
  app.get('/api/audit', async () => db.prepare('SELECT action, entity_type as entityType, entity_id as entityId, details_json as details, created_at as createdAt FROM audit_events ORDER BY created_at DESC LIMIT 500').all());
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webRoot)) app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });
  app.addHook('onClose', async () => { await distributionRegistry?.stop(); await sessionRegistry?.close(); await outboundDistribution?.stop(); await whatsapp?.disconnect(); db.close(); });
  return app;
}
