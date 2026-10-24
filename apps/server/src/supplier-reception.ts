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
  recoveryStatus: 'idle' | 'waiting' | 'received' | 'unavailable';
  recoveryStartedAt: string | null;
  recoveryFinishedAt: string | null;
  recoveryMessageCount: number;
  recoveryWarning: string | null;
  recoveryRequestedGroups: number;
  recoveryMissingAnchors: number;
  recoveryFailedRequests: number;
  lastSupplierMessageAt: string | null;
  lastSupplierGroupJid: string | null;
  lastSupplierResult: string | null;
};

/** Durable receive buffer. Inbox rows are acknowledged as processed only after catalog ingestion commits. */
export class SupplierReceptionService {
  private readonly inboxDirectory: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly draining = new Set<string>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();

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
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
  }

  async scheduleChanged(sessionId: string) {
    await this.drainSession(sessionId);
  }

  archiveProvider(sessionId: string, groupId: string) {
    const rows = this.db.prepare(`SELECT image_file_name as imageFileName FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND status IN ('pending','failed')`)
      .all(sessionId, groupId) as Array<{ imageFileName: string | null }>;
    this.db.prepare(`UPDATE supplier_inbox_messages SET status='ignored',error='Proveedor archivado',processed_at=? WHERE session_id=? AND group_jid=? AND status IN ('pending','failed')`)
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
          status='pending',error=NULL,received_at=excluded.received_at,processed_at=NULL,reception_mode=excluded.reception_mode`)
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

  recordUnsupported(sessionId: string, groupId: string, messageId: string, timestampMs: number, error: string) {
    const now = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,message_timestamp_ms,status,error,received_at)
      VALUES (?,?,?,?,'failed',?,?) ON CONFLICT(session_id,group_jid,message_id) DO UPDATE SET status='failed',error=excluded.error,received_at=excluded.received_at`)
      .run(sessionId, groupId, messageId, timestampMs, error.slice(0, 500), now);
    this.db.prepare("UPDATE supplier_reception_state SET last_supplier_message_at=?,last_supplier_group_jid=?,last_supplier_result='error' WHERE session_id=?")
      .run(new Date(timestampMs).toISOString(), groupId, sessionId);
  }

  beginRecovery(sessionId: string) {
    const schedule = readReceptionSchedule(this.db, sessionId);
    if (recoveryStartTimestampMs(schedule, this.now()) > this.now()) {
      const timer = this.recoveryTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.recoveryTimers.delete(sessionId);
      this.db.prepare(`INSERT INTO supplier_reception_state(session_id,recovery_status,recovery_warning) VALUES (?,'idle',?)
        ON CONFLICT(session_id) DO UPDATE SET recovery_status='idle',recovery_started_at=NULL,recovery_finished_at=NULL,
        recovery_message_count=0,recovery_requested_groups=0,recovery_missing_anchors=0,recovery_failed_requests=0,recovery_warning=excluded.recovery_warning`)
        .run(sessionId, `El rango de hoy todavía no comienza. Se iniciará el intento de recuperación a las ${schedule.startTime}, hora de Colombia. Los mensajes nuevos siguen entrando.`);
      return;
    }
    const now = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO supplier_reception_state(session_id,recovery_status,recovery_started_at,recovery_finished_at,recovery_message_count,recovery_warning)
      VALUES (?,'waiting',?,NULL,0,NULL) ON CONFLICT(session_id) DO UPDATE SET recovery_status='waiting',recovery_started_at=excluded.recovery_started_at,
      recovery_finished_at=NULL,recovery_message_count=0,recovery_warning=NULL`).run(sessionId, now);
    this.db.prepare('UPDATE supplier_reception_state SET recovery_requested_groups=0,recovery_missing_anchors=0,recovery_failed_requests=0 WHERE session_id=?').run(sessionId);
    this.armRecoveryTimeout(sessionId);
  }

  recordRecoveryRequests(sessionId: string, requested: number, missing: number, failed: number) {
    const previous = this.db.prepare('SELECT recovery_requested_groups as requested,recovery_status as status FROM supplier_reception_state WHERE session_id=?').get(sessionId) as { requested: number; status: string } | undefined;
    const warnings: string[] = [];
    if (missing) warnings.push(`${missing} grupo(s) sin una referencia de mensaje dentro o después del rango de hoy. Se intentará al recibir una referencia reciente de WhatsApp o un mensaje nuevo de esos grupos.`);
    if (failed) warnings.push(`Falló la solicitud de historial de ${failed} grupo(s). Puedes volver a intentar la recuperación.`);
    this.db.prepare(`UPDATE supplier_reception_state SET recovery_requested_groups=?,recovery_missing_anchors=?,recovery_failed_requests=?,
      recovery_warning=? WHERE session_id=?`).run(requested, missing, failed, warnings.length ? warnings.join(' ') : RECOVERY_WARNING, sessionId);
    if (previous?.status === 'unavailable' && requested > previous.requested) {
      this.db.prepare("UPDATE supplier_reception_state SET recovery_status='waiting',recovery_finished_at=NULL WHERE session_id=?").run(sessionId);
      this.armRecoveryTimeout(sessionId);
    }
  }

  async recordHistoryBatch(sessionId: string, supplierMessageCount: number) {
    if (supplierMessageCount > 0) {
      // History can arrive after the initial timeout. Reflect it immediately instead
      // of leaving an unavailable status alongside a positive message count.
      const now = new Date(this.now()).toISOString();
      this.db.prepare(`INSERT INTO supplier_reception_state(session_id,recovery_status,recovery_started_at,recovery_finished_at,recovery_message_count,recovery_warning)
        VALUES (?,'received',?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET recovery_status='received',recovery_finished_at=excluded.recovery_finished_at,
          recovery_message_count=recovery_message_count+excluded.recovery_message_count,recovery_warning=excluded.recovery_warning`)
        .run(sessionId, now, now, supplierMessageCount, this.recoveryWarning(sessionId, RECOVERY_WARNING));
      const timer = this.recoveryTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.recoveryTimers.delete(sessionId);
      writeApplicationLog(this.db, { sessionId, category: 'connection', action: 'supplier.history.received', entityType: 'whatsapp_session', entityId: sessionId,
        message: 'WhatsApp entregó mensajes recientes para revisar', details: { supplierMessageCount }, createdAt: now });
    }
  }

  snapshot(sessionId: string): ReceptionSnapshot {
    const counts = this.db.prepare(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pendingCount,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failedCount FROM supplier_inbox_messages WHERE session_id=?`).get(sessionId) as { pendingCount: number | null; failedCount: number | null };
    const row = this.db.prepare(`SELECT recovery_status as recoveryStatus,recovery_started_at as recoveryStartedAt,recovery_finished_at as recoveryFinishedAt,
      recovery_message_count as recoveryMessageCount,recovery_warning as recoveryWarning,last_supplier_message_at as lastSupplierMessageAt,
      last_supplier_group_jid as lastSupplierGroupJid,last_supplier_result as lastSupplierResult,
      recovery_requested_groups as recoveryRequestedGroups,recovery_missing_anchors as recoveryMissingAnchors,recovery_failed_requests as recoveryFailedRequests
      FROM supplier_reception_state WHERE session_id=?`).get(sessionId) as Omit<ReceptionSnapshot, 'pendingCount'|'failedCount'> | undefined;
    return { pendingCount: counts.pendingCount ?? 0, failedCount: counts.failedCount ?? 0, recoveryStatus: row?.recoveryStatus ?? 'idle',
      recoveryStartedAt: row?.recoveryStartedAt ?? null, recoveryFinishedAt: row?.recoveryFinishedAt ?? null,
      recoveryMessageCount: row?.recoveryMessageCount ?? 0, recoveryWarning: row?.recoveryWarning ?? null,
      recoveryRequestedGroups: row?.recoveryRequestedGroups ?? 0, recoveryMissingAnchors: row?.recoveryMissingAnchors ?? 0, recoveryFailedRequests: row?.recoveryFailedRequests ?? 0,
      lastSupplierMessageAt: row?.lastSupplierMessageAt ?? null, lastSupplierGroupJid: row?.lastSupplierGroupJid ?? null,
      lastSupplierResult: row?.lastSupplierResult ?? null };
  }

  private async drainDueSessions() {
    const rows = this.db.prepare('SELECT session_id as sessionId FROM whatsapp_session_settings').all() as Array<{ sessionId: string }>;
    for (const row of rows) {
      await this.drainSession(row.sessionId);
    }
  }

  private recoveryWarning(sessionId: string, fallback: string) {
    const counts = this.db.prepare('SELECT recovery_missing_anchors as missing,recovery_failed_requests as failed FROM supplier_reception_state WHERE session_id=?').get(sessionId) as { missing: number; failed: number } | undefined;
    return [counts?.missing ? `${counts.missing} grupo(s) sin referencia de mensaje dentro o después del rango de hoy; se intentará al recibir una referencia reciente o un mensaje nuevo.` : '',
      counts?.failed ? `Falló la solicitud de historial de ${counts.failed} grupo(s). Puedes volver a intentar.` : '', fallback].filter(Boolean).join(' ');
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
          this.db.prepare("UPDATE supplier_inbox_messages SET status='ignored',error='Fuera del rango de recuperación',processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
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
          this.db.prepare("UPDATE supplier_inbox_messages SET status='processed',error=NULL,processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
            .run(processedAt, sessionId, row.group_jid, row.message_id);
          if (row.image_file_name) rmSync(join(this.inboxDirectory, row.image_file_name), { force: true });
          this.db.prepare("UPDATE supplier_reception_state SET last_supplier_result='stored' WHERE session_id=?").run(sessionId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Error desconocido al procesar la publicación.';
          this.db.prepare("UPDATE supplier_inbox_messages SET status='failed',error=?,processed_at=? WHERE session_id=? AND group_jid=? AND message_id=?")
            .run(detail.slice(0, 500), new Date(this.now()).toISOString(), sessionId, row.group_jid, row.message_id);
          this.db.prepare("UPDATE supplier_reception_state SET last_supplier_result='error' WHERE session_id=?").run(sessionId);
          writeApplicationLog(this.db, { sessionId, level: 'error', category: 'products', action: 'supplier.inbox.processing.failed', entityType: 'whatsapp_group', entityId: row.group_jid,
            message: 'No se pudo procesar una publicación pendiente del proveedor', details: { messageId: row.message_id, error: detail.slice(0, 300) } });
          this.logger.error({ sessionId, messageId: row.message_id, err: error }, 'Error al procesar una publicación guardada en la bandeja');
        }
      }
    } finally {
      this.draining.delete(sessionId);
    }
  }

  private armRecoveryTimeout(sessionId: string) {
    const previous = this.recoveryTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      const state = this.db.prepare('SELECT recovery_status as status,recovery_message_count as count,recovery_requested_groups as requested,recovery_missing_anchors as missing,recovery_failed_requests as failed FROM supplier_reception_state WHERE session_id=?').get(sessionId) as { status: string; count: number; requested: number; missing: number; failed: number } | undefined;
      if (state?.status !== 'waiting') return;
      const status = state.count > 0 ? 'received' : 'unavailable';
      const fallback = state.count > 0 ? RECOVERY_WARNING : state.requested === 0 && state.missing > 0 && state.failed === 0
        ? 'No se pudo solicitar historial al teléfono: faltan referencias recientes de mensajes. Mantén la aplicación conectada; una referencia nueva permitirá iniciar la solicitud. Las publicaciones ya guardadas se conservan.'
        : 'El teléfono no entregó mensajes nuevos del rango en este intento. Revisa que WhatsApp en el teléfono tenga conexión a Internet y pulsa Recuperar historial. Las publicaciones ya guardadas se conservan.';
      const warning = this.recoveryWarning(sessionId, fallback);
      const finishedAt = new Date(this.now()).toISOString();
      this.db.prepare('UPDATE supplier_reception_state SET recovery_status=?,recovery_finished_at=?,recovery_warning=? WHERE session_id=?')
        .run(status, finishedAt, warning, sessionId);
      writeApplicationLog(this.db, { sessionId, level: 'warning', category: 'connection', action: 'supplier.history.attempt.finished', entityType: 'whatsapp_session', entityId: sessionId,
        message: warning, details: { deliveredSupplierMessages: state.count, requestedGroups: state.requested, missingReferences: state.missing, failedRequests: state.failed }, createdAt: finishedAt });
      this.recoveryTimers.delete(sessionId);
    }, 35_000);
    timer.unref();
    this.recoveryTimers.set(sessionId, timer);
  }
}

