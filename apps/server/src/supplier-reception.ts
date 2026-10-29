import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDatabase } from './database.js';
import { isInRecoveryWindow, readReceptionSchedule, recoveryStartTimestampMs } from './reception-schedule.js';
import type { IncomingSupplierMessage, SupplierIngestionService } from './supplier-ingestion.js';
import { writeApplicationLog } from './application-log.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const RECOVERY_WARNING = 'WhatsApp no confirma que haya entregado todo el historial; revisa los grupos proveedor por si faltan publicaciones.';

type InboxRow = {
  session_id: string;
  group_jid: string;
  message_id: string;
  participant_jid: string;
  message_timestamp_ms: number;
  text: string;
  image_file_name: string | null;
  image_mime_type: string | null;
  expected_album_images: number | null;
  reception_mode: 'live' | 'recovery';
};

export type ReceptionSnapshot = {
  pendingCount: number;
  failedCount: number;
  decryptFailureCount: number;
  mediaFailureCount: number;
  recoveryStatus: 'idle' | 'waiting' | 'received' | 'unavailable';
  recoveryStartedAt: string | null;
  recoveryFinishedAt: string | null;
  recoveryMessageCount: number;
  recoverySavedCount: number;
  recoveryWarning: string | null;
  recoveryRequestedGroups: number;
  recoveryPendingGroups: number;
  recoveryRespondedGroups: number;
  recoveryInterruptedGroups: number;
  recoveryMissingAnchors: number;
  recoveryFailedRequests: number;
  lastSupplierMessageAt: string | null;
  lastSupplierGroupJid: string | null;
  lastSupplierResult: string | null;
};

type RecoveryStateRow = Pick<ReceptionSnapshot, 'recoveryStatus'|'recoveryStartedAt'|'recoveryFinishedAt'|'recoveryMessageCount'|'recoveryWarning'|
  'lastSupplierMessageAt'|'lastSupplierGroupJid'|'lastSupplierResult'|'recoveryRequestedGroups'|'recoveryPendingGroups'|'recoveryRespondedGroups'|
  'recoveryInterruptedGroups'|'recoveryMissingAnchors'|'recoveryFailedRequests'>;

/** Durable receive buffer. Inbox rows are acknowledged as processed only after catalog ingestion commits. */
export class SupplierReceptionService {
  private readonly inboxDirectory: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly draining = new Set<string>();
  private readonly recoveryMessages = new Map<string, Set<string>>();

  constructor(
    private readonly db: AppDatabase,
    dataDirectory: string,
    private readonly ingestion: SupplierIngestionService,
    private readonly logger: FastifyBaseLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.inboxDirectory = join(dataDirectory, 'supplier-inbox');
    mkdirSync(this.inboxDirectory, { recursive: true });
    // A crash can occur after catalog commit and before the inbox status update. The
    // ingestion ledger makes replay safe, so reset these leases and drain them again.
    this.db.prepare("UPDATE supplier_inbox_messages SET status='pending',error=NULL WHERE status='processing'").run();
    this.db.prepare(`UPDATE supplier_reception_state SET recovery_status='unavailable',recovery_finished_at=?,
      recovery_warning='La aplicación se reinició antes de terminar el intento anterior; se iniciará otro al conectar.' WHERE recovery_status='waiting'`)
      .run(new Date(this.now()).toISOString());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.drainDueSessions(); }, 15_000);
    this.timer.unref();
    void this.drainDueSessions();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scheduleChanged(sessionId: string) {
    await this.drainSession(sessionId);
  }

  archiveProvider(sessionId: string, groupId: string) {
    const rows = this.db.prepare(`SELECT image_file_name as imageFileName FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND status IN ('pending','failed')`)
      .all(sessionId, groupId) as Array<{ imageFileName: string | null }>;
    this.db.prepare(`UPDATE supplier_inbox_messages SET status='ignored',error='Proveedor archivado',error_code=NULL,processed_at=? WHERE session_id=? AND group_jid=? AND status IN ('pending','failed')`)
      .run(new Date(this.now()).toISOString(), sessionId, groupId);
    for (const row of rows) if (row.imageFileName) rmSync(join(this.inboxDirectory, row.imageFileName), { force: true });
  }

  async capture(message: IncomingSupplierMessage, deferUntilBatchEnd = false): Promise<'stored' | 'duplicate' | 'pending' | 'failed' | 'outside_window'> {
    const sessionId = message.sessionId ?? 'main';
    if (!message.messageId || !this.ingestion.isSupplierGroup(message.groupId, sessionId)) return 'duplicate';
    const mode = message.receptionMode ?? 'live';
    if (mode === 'recovery' && !isInRecoveryWindow(message.timestampMs, readReceptionSchedule(this.db, sessionId), this.now())) return 'outside_window';
    const existingInbox = this.db.prepare('SELECT status,image_file_name as imageFileName FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(sessionId, message.groupId, message.messageId) as { status: string; imageFileName: string | null } | undefined;
    const alreadyProcessed = this.db.prepare('SELECT 1 FROM whatsapp_source_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(sessionId, message.groupId, message.messageId);
    if (alreadyProcessed || existingInbox && existingInbox.status !== 'failed') return 'duplicate';

    let fileName: string | null = null;
    let temporaryPath: string | undefined;
    if (message.image) {
      const extension = EXTENSIONS[message.image.mimeType];
      if (!extension || message.image.bytes.length === 0 || message.image.bytes.length > MAX_IMAGE_BYTES) {
        throw new Error('La imagen recibida está vacía, supera 20 MiB o tiene un formato no admitido.');
      }
      fileName = `${randomUUID()}${extension}`;
      temporaryPath = join(this.inboxDirectory, `${fileName}.tmp`);
      writeFileSync(temporaryPath, message.image.bytes, { flag: 'wx' });
      renameSync(temporaryPath, join(this.inboxDirectory, fileName));
    }

    const eventDate = new Date(message.timestampMs);
    const timestampMs = Number.isNaN(eventDate.valueOf()) ? this.now() : message.timestampMs;
    const nowIso = new Date(this.now()).toISOString();
    const participantId = message.participantId ?? '';
    try {
      this.db.prepare(`INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,participant_jid,message_timestamp_ms,text,image_file_name,image_mime_type,expected_album_images,status,error,received_at,processed_at,reception_mode)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,?,NULL,?)
        ON CONFLICT(session_id,group_jid,message_id) DO UPDATE SET participant_jid=excluded.participant_jid,message_timestamp_ms=excluded.message_timestamp_ms,
          text=excluded.text,image_file_name=excluded.image_file_name,image_mime_type=excluded.image_mime_type,expected_album_images=excluded.expected_album_images,
          status='pending',error=NULL,error_code=NULL,received_at=excluded.received_at,processed_at=NULL,reception_mode=excluded.reception_mode`)
        .run(sessionId, message.groupId, message.messageId, participantId, timestampMs, message.text, fileName, message.image?.mimeType ?? null, message.image?.expectedAlbumImages ?? null, nowIso, mode);
    } catch (error) {
      if (fileName) rmSync(join(this.inboxDirectory, fileName), { force: true });
      if (temporaryPath) rmSync(temporaryPath, { force: true });
      throw error;
    }
    if (existingInbox?.imageFileName) rmSync(join(this.inboxDirectory, existingInbox.imageFileName), { force: true });

    this.db.prepare(`UPDATE supplier_reception_state SET last_supplier_message_at=?,last_supplier_group_jid=?,last_supplier_result='pending' WHERE session_id=?`)
      .run(new Date(timestampMs).toISOString(), message.groupId, sessionId);
    writeApplicationLog(this.db, {
      sessionId, category: 'products', action: 'supplier.inbox.captured', entityType: 'whatsapp_group', entityId: message.groupId,
      message: 'Se guardó una publicación del proveedor en la bandeja local',
      details: { messageId: message.messageId, hasImage: Boolean(fileName) }, createdAt: nowIso,
    });

    if (deferUntilBatchEnd) return 'pending';
    await this.drainSession(sessionId);
    const result = this.db.prepare('SELECT status FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(sessionId, message.groupId, message.messageId) as { status: string } | undefined;
    return result?.status === 'processed' ? 'stored' : result?.status === 'failed' ? 'failed' : result?.status === 'ignored' ? 'outside_window' : 'pending';
  }

  recordUnsupported(sessionId: string, groupId: string, messageId: string, timestampMs: number, errorCode = 'unsupported') {
    const now = new Date(this.now()).toISOString();
    const error = errorCode === 'decrypt_pending' ? 'WhatsApp no pudo descifrar este mensaje. Se espera una nueva entrega antes de incorporarlo al catálogo.'
      : errorCode === 'media_download_failed' ? 'No se pudo descargar la publicación del proveedor.'
        : errorCode === 'processing_failed' ? 'No se pudo guardar la publicación del proveedor.'
          : 'Mensaje de proveedor no compatible.';
    this.db.prepare(`INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,message_timestamp_ms,status,error,error_code,received_at)
      VALUES (?,?,?,?,'failed',?,?,?) ON CONFLICT(session_id,group_jid,message_id) DO UPDATE SET status='failed',error=excluded.error,error_code=excluded.error_code,received_at=excluded.received_at`)
      .run(sessionId, groupId, messageId, timestampMs, error.slice(0, 500), errorCode, now);
    this.db.prepare("UPDATE supplier_reception_state SET last_supplier_message_at=?,last_supplier_group_jid=?,last_supplier_result='error' WHERE session_id=?")
      .run(new Date(timestampMs).toISOString(), groupId, sessionId);
  }

  beginRecovery(sessionId: string) {
    this.recoveryMessages.set(sessionId, new Set());
    const schedule = readReceptionSchedule(this.db, sessionId);
    if (recoveryStartTimestampMs(schedule, this.now()) > this.now()) {
      this.db.prepare(`INSERT INTO supplier_reception_state(session_id,recovery_status,recovery_warning) VALUES (?,'idle',?)
        ON CONFLICT(session_id) DO UPDATE SET recovery_status='idle',recovery_started_at=NULL,recovery_finished_at=NULL,
        recovery_message_count=0,recovery_requested_groups=0,recovery_pending_groups=0,recovery_responded_groups=0,recovery_interrupted_groups=0,
        recovery_missing_anchors=0,recovery_failed_requests=0,recovery_warning=excluded.recovery_warning`)
        .run(sessionId, `El rango de hoy todavía no comienza. Se iniciará el intento de recuperación a las ${schedule.startTime}, hora de Colombia. Los mensajes nuevos siguen entrando.`);
      return;
    }
    const now = new Date(this.now()).toISOString();
    const previous = this.db.prepare('SELECT recovery_interrupted_groups as interrupted FROM supplier_reception_state WHERE session_id=?')
      .get(sessionId) as { interrupted: number } | undefined;
    const interrupted = previous?.interrupted ?? 0;
    const warning = interrupted ? `El intento anterior se interrumpió con ${interrupted} grupo(s) pendientes; se inició otro intento.` : null;
    this.db.prepare(`INSERT INTO supplier_reception_state(session_id,recovery_status,recovery_started_at,recovery_finished_at,recovery_message_count,recovery_warning)
      VALUES (?,'waiting',?,NULL,0,NULL) ON CONFLICT(session_id) DO UPDATE SET recovery_status='waiting',recovery_started_at=excluded.recovery_started_at,
      recovery_finished_at=NULL,recovery_message_count=0,recovery_warning=?`).run(sessionId, now, warning);
    this.db.prepare(`UPDATE supplier_reception_state SET recovery_requested_groups=0,recovery_pending_groups=0,recovery_responded_groups=0,
      recovery_interrupted_groups=?,recovery_missing_anchors=0,recovery_failed_requests=0 WHERE session_id=?`).run(interrupted, sessionId);
  }

  recordRecoveryRequests(sessionId: string, requested: number, missing: number, failed: number, pending: number, responded: number) {
    const previous = this.db.prepare(`SELECT recovery_requested_groups as requested,recovery_failed_requests as failed,recovery_responded_groups as responded,
      recovery_interrupted_groups as interrupted,
      recovery_status as status FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as { requested: number; failed: number; responded: number; interrupted: number; status: string } | undefined;
    const warnings: string[] = [];
    if (missing) warnings.push(`${missing} grupo(s) sin una referencia de mensaje dentro o después del rango de hoy. Se intentará al recibir una referencia reciente de WhatsApp o un mensaje nuevo de esos grupos.`);
    if (failed) warnings.push(`No se completó la recuperación de historial de ${failed} grupo(s). Puedes volver a intentar la recuperación.`);
    if (previous?.interrupted) warnings.push(`El intento anterior se interrumpió con ${previous.interrupted} grupo(s) pendientes; se inició otro intento.`);
    this.db.prepare(`UPDATE supplier_reception_state SET recovery_requested_groups=?,recovery_pending_groups=?,recovery_responded_groups=?,recovery_missing_anchors=?,recovery_failed_requests=?,
      recovery_warning=? WHERE session_id=?`).run(requested, pending, responded, missing, failed, warnings.length ? warnings.join(' ') : RECOVERY_WARNING, sessionId);
    if (previous?.status === 'unavailable' && (pending > 0 || requested > previous.requested || failed < previous.failed || responded > previous.responded)) {
      this.db.prepare("UPDATE supplier_reception_state SET recovery_status='waiting',recovery_finished_at=NULL WHERE session_id=?").run(sessionId);
    }
  }

  async recordHistoryBatch(sessionId: string, messages: Array<{ groupId: string; messageId: string }> | number) {
    let supplierMessageCount = typeof messages === 'number' ? messages : 0;
    if (Array.isArray(messages)) {
      const seen = this.recoveryMessages.get(sessionId) ?? new Set<string>();
      this.recoveryMessages.set(sessionId, seen);
      for (const item of messages) {
        const key = `${item.groupId}\u0000${item.messageId}`;
        if (!seen.has(key)) { seen.add(key); supplierMessageCount += 1; }
      }
    }
    if (supplierMessageCount > 0) {
      const now = new Date(this.now()).toISOString();
      this.db.prepare(`UPDATE supplier_reception_state SET recovery_status=CASE WHEN recovery_status='unavailable' THEN 'received' ELSE recovery_status END,
        recovery_finished_at=CASE WHEN recovery_status='unavailable' THEN ? ELSE recovery_finished_at END,
        recovery_message_count=recovery_message_count+?,recovery_warning=? WHERE session_id=?`)
        .run(now, supplierMessageCount, this.recoveryWarning(sessionId, RECOVERY_WARNING), sessionId);
      writeApplicationLog(this.db, { sessionId, category: 'connection', action: 'supplier.history.received', entityType: 'whatsapp_session', entityId: sessionId,
        message: 'WhatsApp entregó mensajes recientes para revisar', details: { supplierMessageCount }, createdAt: now });
    }
  }

  finishRecovery(sessionId: string, interruptedGroups = 0) {
    const row = this.db.prepare(`SELECT recovery_message_count as messageCount,recovery_responded_groups as responded,
      recovery_requested_groups as requested,recovery_failed_requests as failed,recovery_missing_anchors as missing
      FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as { messageCount: number; responded: number; requested: number; failed: number; missing: number } | undefined;
    if (!row) return;
    const now = new Date(this.now()).toISOString();
    const fallback = interruptedGroups
      ? `La conexión se interrumpió durante la recuperación; ${interruptedGroups} grupo(s) quedaron pendientes.`
      : row.messageCount > 0
        ? RECOVERY_WARNING
        : row.failed > 0
          ? `No se recibió historial de ${row.failed} grupo(s) después de los reintentos.`
          : row.requested > row.responded
            ? 'WhatsApp no confirmó respuestas a todas las solicitudes de historial.'
            : row.responded > 0
              ? 'WhatsApp respondió las solicitudes, pero no entregó publicaciones dentro del rango.'
              : 'No había referencias recientes para solicitar historial.';
    const warning = this.recoveryWarning(sessionId, fallback, interruptedGroups);
    const status = row.messageCount > 0 ? 'received' : 'unavailable';
    this.db.prepare(`UPDATE supplier_reception_state SET recovery_status=?,recovery_finished_at=?,recovery_pending_groups=0,
      recovery_interrupted_groups=?,recovery_warning=? WHERE session_id=?`)
      .run(status, now, interruptedGroups, warning, sessionId);
    writeApplicationLog(this.db, { sessionId, level: status === 'received' ? 'info' : 'warning', category: 'connection', action: 'supplier.history.attempt.finished', entityType: 'whatsapp_session', entityId: sessionId,
      message: warning, details: { deliveredSupplierMessages: row.messageCount, requestedGroups: row.requested, respondedGroups: row.responded,
        missingReferences: row.missing, failedRequests: row.failed, interruptedGroups }, createdAt: now });
  }

  snapshot(sessionId: string): ReceptionSnapshot {
    const counts = this.db.prepare(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pendingCount,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failedCount,
      SUM(CASE WHEN status='failed' AND error_code='decrypt_pending' THEN 1 ELSE 0 END) as decryptFailureCount,
      SUM(CASE WHEN status='failed' AND error_code='media_download_failed' THEN 1 ELSE 0 END) as mediaFailureCount
      FROM supplier_inbox_messages WHERE session_id=?`).get(sessionId) as { pendingCount: number | null; failedCount: number | null; decryptFailureCount: number | null; mediaFailureCount: number | null };
    const row = this.db.prepare(`SELECT recovery_status as recoveryStatus,recovery_started_at as recoveryStartedAt,recovery_finished_at as recoveryFinishedAt,
      recovery_message_count as recoveryMessageCount,recovery_warning as recoveryWarning,last_supplier_message_at as lastSupplierMessageAt,
      last_supplier_group_jid as lastSupplierGroupJid,last_supplier_result as lastSupplierResult,
      recovery_requested_groups as recoveryRequestedGroups,recovery_pending_groups as recoveryPendingGroups,recovery_responded_groups as recoveryRespondedGroups,
      recovery_interrupted_groups as recoveryInterruptedGroups,recovery_missing_anchors as recoveryMissingAnchors,recovery_failed_requests as recoveryFailedRequests
      FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as RecoveryStateRow | undefined;
    const saved = this.db.prepare(`SELECT COUNT(DISTINCT m.product_id) as count FROM supplier_inbox_messages i
      JOIN whatsapp_source_messages m ON m.session_id=i.session_id AND m.group_jid=i.group_jid AND m.message_id=i.message_id AND m.product_id IS NOT NULL
      JOIN supplier_reception_state s ON s.session_id=i.session_id
      WHERE i.session_id=? AND i.status='processed' AND i.reception_mode='recovery' AND s.recovery_started_at IS NOT NULL AND i.received_at>=s.recovery_started_at`).get(sessionId) as { count: number };
    return { pendingCount: counts.pendingCount ?? 0, failedCount: counts.failedCount ?? 0, decryptFailureCount: counts.decryptFailureCount ?? 0, mediaFailureCount: counts.mediaFailureCount ?? 0,
      recoveryStatus: row?.recoveryStatus ?? 'idle',
      recoveryStartedAt: row?.recoveryStartedAt ?? null, recoveryFinishedAt: row?.recoveryFinishedAt ?? null,
      recoveryMessageCount: row?.recoveryMessageCount ?? 0, recoverySavedCount: saved.count ?? 0, recoveryWarning: row?.recoveryWarning ?? null,
      recoveryRequestedGroups: row?.recoveryRequestedGroups ?? 0, recoveryPendingGroups: row?.recoveryPendingGroups ?? 0,
      recoveryRespondedGroups: row?.recoveryRespondedGroups ?? 0, recoveryInterruptedGroups: row?.recoveryInterruptedGroups ?? 0,
      recoveryMissingAnchors: row?.recoveryMissingAnchors ?? 0, recoveryFailedRequests: row?.recoveryFailedRequests ?? 0,
      lastSupplierMessageAt: row?.lastSupplierMessageAt ?? null, lastSupplierGroupJid: row?.lastSupplierGroupJid ?? null,
      lastSupplierResult: row?.lastSupplierResult ?? null };
  }

  private async drainDueSessions() {
    const rows = this.db.prepare('SELECT session_id as sessionId FROM whatsapp_session_settings').all() as Array<{ sessionId: string }>;
    for (const row of rows) {
      await this.drainSession(row.sessionId);
    }
  }

  private recoveryWarning(sessionId: string, fallback: string, interruptedOverride?: number) {
    const counts = this.db.prepare(`SELECT recovery_missing_anchors as missing,recovery_failed_requests as failed,recovery_interrupted_groups as interrupted
      FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as { missing: number; failed: number; interrupted: number } | undefined;
    return [counts?.missing ? `${counts.missing} grupo(s) sin una referencia de mensaje dentro o después del rango de hoy; se intentará al recibir una referencia reciente o un mensaje nuevo.` : '',
      counts?.failed ? `No se completó la recuperación de historial de ${counts.failed} grupo(s). Puedes volver a intentar.` : '',
      (interruptedOverride ?? counts?.interrupted) ? `La conexión interrumpió la recuperación de ${interruptedOverride ?? counts?.interrupted} grupo(s).` : '', fallback].filter(Boolean).join(' ');
  }

  private async drainSession(sessionId: string) {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      const archived = this.db.prepare(`SELECT i.group_jid as groupId,i.message_id as messageId,i.image_file_name as imageFileName FROM supplier_inbox_messages i
        LEFT JOIN supplier_profiles p ON p.session_id=i.session_id AND p.source_group_id=i.group_jid AND p.archived_at IS NULL
        WHERE i.session_id=? AND i.status='pending' AND p.id IS NULL`).all(sessionId) as Array<{ groupId: string; messageId: string; imageFileName: string | null }>;
      for (const item of archived) {
        this.db.prepare("UPDATE supplier_inbox_messages SET status='ignored',error='Proveedor archivado',processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
          .run(new Date(this.now()).toISOString(), sessionId, item.groupId, item.messageId);
        if (item.imageFileName) rmSync(join(this.inboxDirectory, item.imageFileName), { force: true });
      }
      const pending = this.db.prepare(`SELECT i.session_id,i.group_jid,i.message_id,i.participant_jid,i.message_timestamp_ms,i.text,i.image_file_name,i.image_mime_type,i.expected_album_images,i.reception_mode
        FROM supplier_inbox_messages i JOIN supplier_profiles p ON p.session_id=i.session_id AND p.source_group_id=i.group_jid AND p.archived_at IS NULL
        WHERE i.session_id=? AND i.status='pending' ORDER BY i.message_timestamp_ms ASC,i.received_at ASC,i.message_id ASC`).all(sessionId) as InboxRow[];
      for (const row of pending) {
        if (row.reception_mode === 'recovery' && !isInRecoveryWindow(row.message_timestamp_ms, readReceptionSchedule(this.db, sessionId), this.now())) {
          this.db.prepare("UPDATE supplier_inbox_messages SET status='ignored',error='Fuera del rango de recuperación',error_code=NULL,processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
            .run(new Date(this.now()).toISOString(), sessionId, row.group_jid, row.message_id);
          if (row.image_file_name) rmSync(join(this.inboxDirectory, row.image_file_name), { force: true });
          continue;
        }
        this.db.prepare("UPDATE supplier_inbox_messages SET status='processing',error=NULL WHERE session_id=? AND group_jid=? AND message_id=? AND status='pending'")
          .run(sessionId, row.group_jid, row.message_id);
        try {
          const message: IncomingSupplierMessage = { sessionId: row.session_id, groupId: row.group_jid, messageId: row.message_id,
            participantId: row.participant_jid || null, timestampMs: row.message_timestamp_ms, text: row.text,
            ...(row.image_file_name && row.image_mime_type ? { image: { bytes: readFileSync(join(this.inboxDirectory, row.image_file_name)), mimeType: row.image_mime_type,
              ...(row.expected_album_images == null ? {} : { expectedAlbumImages: row.expected_album_images }) } } : {}) };
          await this.ingestion.receive(message);
          const processedAt = new Date(this.now()).toISOString();
          this.db.prepare("UPDATE supplier_inbox_messages SET status='processed',error=NULL,error_code=NULL,processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
            .run(processedAt, sessionId, row.group_jid, row.message_id);
          if (row.image_file_name) rmSync(join(this.inboxDirectory, row.image_file_name), { force: true });
          this.db.prepare("UPDATE supplier_reception_state SET last_supplier_result='stored' WHERE session_id=?").run(sessionId);
        } catch (error) {
          const errorType = error instanceof Error ? error.name : 'UnknownError';
          this.db.prepare("UPDATE supplier_inbox_messages SET status='failed',error='No se pudo procesar la publicación del proveedor.',error_code='processing_failed',processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
            .run(new Date(this.now()).toISOString(), sessionId, row.group_jid, row.message_id);
          this.db.prepare("UPDATE supplier_reception_state SET last_supplier_result='error' WHERE session_id=?").run(sessionId);
          writeApplicationLog(this.db, { sessionId, level: 'error', category: 'products', action: 'supplier.inbox.processing.failed', entityType: 'whatsapp_group', entityId: row.group_jid,
            message: 'No se pudo procesar una publicación pendiente del proveedor', details: { messageId: row.message_id, errorType } });
          this.logger.error({ sessionId, groupId: row.group_jid, messageId: row.message_id, errorType }, 'Error al procesar una publicación guardada en la bandeja');
        }
      }
    } finally {
      this.draining.delete(sessionId);
    }
  }

}

