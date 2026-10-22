import makeWASocket, { DisconnectReason, downloadMediaMessage, normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { FastifyBaseLogger } from 'fastify';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import type { AppDatabase } from './database.js';
import { currentUserProtector, EncryptedWhatsAppAuth } from './encrypted-auth.js';
import type { IncomingSupplierMessage, SupplierIngestionService } from './supplier-ingestion.js';
import { writeApplicationLog } from './application-log.js';
import type { SupplierReceptionService } from './supplier-reception.js';

const baileysLogger = pino({ level: 'silent' });
const DOCUMENT_IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

function documentImageMimeType(document: { mimetype?: string | null; fileName?: string | null }): string | undefined {
  const mimeType = document.mimetype?.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType?.startsWith('image/')) return mimeType;
  const extension = document.fileName?.split('.').pop()?.toLowerCase();
  return extension ? DOCUMENT_IMAGE_EXTENSIONS[extension] : undefined;
}

export type WhatsAppStatus = 'disabled' | 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out';
export type WhatsAppGroup = { id: string; name: string };
export type WhatsAppReceptionResult = 'processing' | 'stored' | 'duplicate' | 'pending' | 'older_message_skipped' | 'unsupported_message' | 'error';
export type WhatsAppReceptionDiagnostics = {
  lastUpsertAt: string | null;
  lastUpsertType: 'notify' | 'append' | null;
  lastUpsertMessageCount: number;
  lastGroupMessageAt: string | null;
  lastGroupName: string | null;
  lastSupplierMessageAt: string | null;
  lastSupplierName: string | null;
  lastSupplierResult: WhatsAppReceptionResult | null;
};

const MAX_APPENDED_SUPPLIER_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const ACCEPTED_HISTORY_TYPES = new Set<number>([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.RECENT,
  proto.HistorySync.HistorySyncType.ON_DEMAND,
]);

/** Baileys can append recent messages received while the linked phone was unavailable. */
export function shouldIngestSupplierMessage(_upsertType: 'notify' | 'append' | 'history', messageTimestampMs: number, nowMs = Date.now()): boolean {
  return Number.isFinite(messageTimestampMs)
    && messageTimestampMs <= nowMs + 5 * 60 * 1000
    && nowMs - messageTimestampMs <= MAX_APPENDED_SUPPLIER_MESSAGE_AGE_MS;
}

export interface WhatsAppConnector {
  status(): { status: WhatsAppStatus; qr: string | null; lastError: string | null; reception?: WhatsAppReceptionDiagnostics };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  resetSession(): Promise<void>;
  listGroups(): Promise<WhatsAppGroup[]>;
  sendImage(groupId: string, bytes: Buffer, mimeType: string, caption?: string): Promise<{ messageId: string }>;
}

/** Experimental WhatsApp Web adapter. Real sends are restricted to explicitly selected targets. */
export class BaileysConnector implements WhatsAppConnector {
  private socket: ReturnType<typeof makeWASocket> | undefined;
  private currentStatus: WhatsAppStatus = 'disconnected';
  private qr: string | null = null;
  private lastError: string | null = null;
  private groups: WhatsAppGroup[] = [];
  private starting = false;
  private groupRefresh: { socket: ReturnType<typeof makeWASocket>; promise: Promise<void> } | undefined;
  private nextGroupRefreshAt = 0;
  private reception: WhatsAppReceptionDiagnostics = this.emptyReceptionDiagnostics();

  constructor(private readonly db: AppDatabase, private readonly logger: FastifyBaseLogger, private readonly enabled: boolean, private readonly supplierIngestion?: SupplierIngestionService, readonly sessionId = 'main', private readonly supplierReception?: SupplierReceptionService) {}

  status() {
    return { status: this.enabled ? this.currentStatus : 'disabled' as const, qr: this.qr, lastError: this.lastError, reception: { ...this.reception } };
  }

  async connect() {
    if (!this.enabled) throw new Error('La integración está deshabilitada. Activa WHATSAPP_ENABLED=true para habilitarla.');
    if (this.starting || this.socket) return;
    this.starting = true;
    this.currentStatus = 'connecting';
    this.qr = null;
    this.lastError = null;
    this.nextGroupRefreshAt = 0;
    this.reception = this.emptyReceptionDiagnostics();
    try {
      const auth = await EncryptedWhatsAppAuth.create(this.db, currentUserProtector(), this.sessionId);
      const { state, saveCreds } = await auth.state();
      const skippedHistoryTypes = new Set<number>();
      const hasSuppliers = () => Boolean(this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL LIMIT 1').get(this.sessionId));
      const socket = makeWASocket({ auth: state, logger: baileysLogger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
        shouldSyncHistoryMessage: (notification) => {
          if (notification.syncType == null || !hasSuppliers()) return false;
          const accepted = ACCEPTED_HISTORY_TYPES.has(notification.syncType);
          if (!accepted && !skippedHistoryTypes.has(notification.syncType)) {
            skippedHistoryTypes.add(notification.syncType);
            writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.type.skipped', entityType: 'whatsapp_session', entityId: this.sessionId,
              message: 'Se omitió una sincronización de historial completo o de metadatos', details: { syncType: notification.syncType } });
          }
          return accepted;
        } });
      this.socket = socket;
      let eventQueue = Promise.resolve();
      let messageQueue = Promise.resolve();
      let credentialSaveFailed = false;
      let recoveryStarted = false;
      const beginRecovery = () => {
        if (!recoveryStarted && this.supplierReception && hasSuppliers()) {
          this.supplierReception.beginRecovery(this.sessionId);
          recoveryStarted = true;
        }
      };
      const enqueue = (handler: () => Promise<void> | void) => {
        eventQueue = eventQueue.then(handler).catch((error: unknown) => this.fail(error));
      };
      socket.ev.on('creds.update', () => enqueue(async () => {
        if (this.socket === socket) {
          try { await saveCreds(); }
          catch (error) { credentialSaveFailed = true; throw error; }
        }
      }));
      socket.ev.on('connection.update', (update) => enqueue(async () => {
        if (this.socket !== socket) return;
        if (update.qr) {
          const firstQrForAttempt = this.currentStatus !== 'qr';
          this.qr = update.qr;
          this.currentStatus = 'qr';
          if (firstQrForAttempt) writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'whatsapp.qr.generated', entityType: 'whatsapp_session', entityId: this.sessionId, message: 'Se generó un QR para vincular WhatsApp. El código no se guarda en el historial' });
        }
        if (update.isNewLogin) {
          this.qr = null;
          this.currentStatus = 'connecting';
          this.lastError = null;
          this.logger.info('WhatsApp aceptó el QR; completando el inicio de sesión');
        }
        if (update.connection === 'open') {
          this.currentStatus = 'connected';
          this.qr = null;
          this.lastError = null;
          this.logger.info('Sesión experimental de WhatsApp conectada');
          writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'whatsapp.session.connected', entityType: 'whatsapp_session', entityId: this.sessionId, message: 'La sesión de WhatsApp quedó conectada' });
          beginRecovery();
          void this.refreshGroups();
        }
        if (update.connection === 'close') {
          const disconnectError = update.lastDisconnect?.error;
          const status = (disconnectError as Boom | undefined)?.output?.statusCode;
          this.qr = null;
          this.socket = undefined;
          if (status === DisconnectReason.restartRequired && !credentialSaveFailed) {
            this.currentStatus = 'connecting';
            this.lastError = null;
            this.logger.info({ statusCode: status }, 'WhatsApp requiere reiniciar el socket para completar la vinculación');
            await this.connect();
          } else if (status === DisconnectReason.loggedOut) {
            this.currentStatus = 'logged_out';
            this.clearStoredSession();
            this.lastError = 'WhatsApp cerró la sesión guardada. Genera un QR nuevo para volver a vincular.';
            this.logger.warn({ statusCode: status }, 'WhatsApp cerró la sesión; se eliminaron las credenciales locales para permitir una nueva vinculación');
            writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'whatsapp.session.logged_out', entityType: 'whatsapp_session', entityId: this.sessionId, message: 'WhatsApp cerró la sesión vinculada. Es necesario volver a conectarla', details: { statusCode: status } });
          } else {
            this.currentStatus = 'disconnected';
            const detail = disconnectError instanceof Error ? disconnectError.message : 'sin detalle adicional';
            this.lastError = credentialSaveFailed
              ? 'No se pudieron guardar las credenciales de vinculación. Revisa el acceso al Llavero y vuelve a intentarlo.'
              : `La conexión se cerró${status ? ` (código ${status})` : ''}: ${detail}`;
            this.logger.warn({ statusCode: status, disconnectMessage: detail }, 'Conexión experimental de WhatsApp cerrada');
            writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'whatsapp.session.disconnected', entityType: 'whatsapp_session', entityId: this.sessionId, message: 'La conexión de WhatsApp se cerró', details: { statusCode: typeof status === 'number' ? status : null } });
          }
        }
      }));
      socket.ev.on('groups.update', () => { void this.refreshGroups(); });
      socket.ev.on('group-participants.update', () => { void this.refreshGroups(); });
      const enqueueMessages = (messages: WAMessage[], type: 'notify' | 'append' | 'history') => {
        messageQueue = messageQueue.then(async () => {
          if (this.socket !== socket || !this.supplierIngestion) return;
          const ordered = [...messages].sort((a, b) => Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0));
          if (type !== 'notify' && this.supplierReception) {
            beginRecovery();
            const eligibleCount = ordered.filter((message) => {
              const groupId = message.key.remoteJid;
              const timestampMs = Number(message.messageTimestamp ?? 0) * 1000;
              if (message.key.fromMe || !groupId?.endsWith('@g.us') || !message.key.id || !this.supplierIngestion?.isSupplierGroup(groupId, this.sessionId) || !shouldIngestSupplierMessage(type, timestampMs)) return false;
              const seen = this.db.prepare('SELECT 1 FROM whatsapp_source_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(this.sessionId, groupId, message.key.id)
                ?? this.db.prepare("SELECT 1 FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=? AND status<>'failed'").get(this.sessionId, groupId, message.key.id);
              return !seen;
            }).length;
            await this.supplierReception.recordHistoryBatch(this.sessionId, eligibleCount);
          }
          this.reception = { ...this.reception, lastUpsertAt: new Date().toISOString(), lastUpsertType: type === 'history' ? 'append' : type, lastUpsertMessageCount: messages.length };
          for (const message of ordered) await this.handleSupplierMessage(socket, message, type);
          if (type === 'history') await this.supplierReception?.scheduleChanged(this.sessionId);
        }).catch((error: unknown) => this.fail(error));
      };
      socket.ev.on('messages.upsert', (event) => enqueueMessages(event.messages, event.type));
      socket.ev.on('messaging-history.set', (event) => {
        // Mirror the download filter for directly emitted / replayed history events.
        if (event.syncType != null && !ACCEPTED_HISTORY_TYPES.has(event.syncType)) return;
        enqueueMessages(event.messages, 'history');
      });
    } catch (error) {
      this.currentStatus = 'disconnected';
      this.socket = undefined;
      this.fail(error);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async disconnect() {
    const socket = this.socket;
    this.socket = undefined;
    this.qr = null;
    this.currentStatus = 'disconnected';
    this.groups = [];
    if (socket) socket.end(undefined);
  }

  async resetSession() {
    if (this.currentStatus === 'connected' || this.currentStatus === 'connecting' || this.starting) {
      throw new Error('Desconecta la sesión antes de restablecer la vinculación.');
    }
    const socket = this.socket;
    this.socket = undefined;
    this.qr = null;
    this.currentStatus = 'disconnected';
    this.lastError = null;
    this.groups = [];
    this.clearStoredSession();
    if (socket) socket.end(undefined);
  }

  async listGroups() {
    if (this.currentStatus !== 'connected' || !this.socket) return this.groups;
    await this.refreshGroups();
    return this.groups;
  }

  async sendImage(groupId: string, bytes: Buffer, mimeType: string, caption?: string) {
    if (!this.enabled || this.currentStatus !== 'connected' || !this.socket) throw new Error('WhatsApp no está conectado para publicar.');
    const settings = this.db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(this.sessionId) as { target_group_ids: string } | undefined;
    const targets = JSON.parse(settings?.target_group_ids ?? '[]') as string[];
    const isSource = this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId);
    const hasFrozenPublication = this.db.prepare(`SELECT 1 FROM outbound_publications p JOIN outbound_units u ON u.publication_id=p.id
      WHERE p.session_id=? AND p.group_id=? AND p.status='in_progress' AND u.status='transmitting' LIMIT 1`).get(this.sessionId, groupId);
    if ((!targets.includes(groupId) && !hasFrozenPublication) || isSource) throw new Error('El grupo no está habilitado como destino de publicación.');
    const result = await this.socket.sendMessage(groupId, {
      image: bytes,
      mimetype: mimeType,
      ...(caption === undefined ? {} : { caption }),
    });
    if (!result?.key.id) throw new Error('Baileys no devolvió el identificador de la unidad publicada.');
    return { messageId: result.key.id };
  }

  private async handleSupplierMessage(socket: ReturnType<typeof makeWASocket>, message: WAMessage, upsertType: 'notify' | 'append' | 'history') {
    if (!this.supplierIngestion) return;
    const groupId = message.key.remoteJid;
    const messageId = message.key.id;
    if (!groupId?.endsWith('@g.us') || message.key.fromMe || !messageId || !this.supplierIngestion.isSupplierGroup(groupId, this.sessionId)) return;
    const groupName = (this.db.prepare('SELECT subject FROM whatsapp_groups WHERE session_id=? AND jid=?').get(this.sessionId, groupId) as { subject: string } | undefined)?.subject ?? groupId;
    const supplierName = (this.db.prepare('SELECT name FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId) as { name: string } | undefined)?.name ?? groupName;
    const at = new Date().toISOString();
    this.reception = { ...this.reception, lastGroupMessageAt: at, lastGroupName: groupName, lastSupplierMessageAt: at, lastSupplierName: supplierName, lastSupplierResult: 'processing' };
    const rawTimestamp = Number(message.messageTimestamp ?? (upsertType === 'notify' ? Date.now() / 1000 : Number.NaN));
    const messageTimestampMs = Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp * 1000 : Number.NaN;
    if (!shouldIngestSupplierMessage(upsertType, messageTimestampMs)) {
      this.reception = { ...this.reception, lastSupplierResult: 'older_message_skipped' };
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'products', action: 'product.received.too_old', entityType: 'whatsapp_group', entityId: groupId, message: 'Se omitió un mensaje del proveedor con más de 24 horas', details: { supplierName, upsertType } });
      return;
    }
    const inbox = this.db.prepare('SELECT status FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(this.sessionId, groupId, messageId) as { status: string } | undefined;
    const ledger = this.db.prepare('SELECT 1 FROM whatsapp_source_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(this.sessionId, groupId, messageId);
    if (ledger || inbox && inbox.status !== 'failed') {
      this.reception = { ...this.reception, lastSupplierResult: inbox?.status === 'pending' ? 'pending' : 'duplicate' };
      return;
    }
    const content = normalizeMessageContent(message.message);
    if (!content) {
      this.reception = { ...this.reception, lastSupplierResult: 'unsupported_message' };
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'products', action: 'product.received.unsupported', entityType: 'whatsapp_group', entityId: groupId, message: 'No se pudo procesar un mensaje del proveedor porque no tiene contenido compatible', details: { supplierName } });
      return;
    }
    const text = content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption ?? '';
    const documentImage = content.documentMessage && documentImageMimeType(content.documentMessage) ? content.documentMessage : undefined;
    const image = content.imageMessage ?? documentImage;
    if (!text.trim() && !image) {
      this.reception = { ...this.reception, lastSupplierResult: 'unsupported_message' };
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'products', action: 'product.received.unsupported', entityType: 'whatsapp_group', entityId: groupId, message: 'Se omitió un mensaje del proveedor que no contiene texto ni fotografía compatible', details: { supplierName, messageTypes: Object.keys(content).filter((key) => key !== 'messageContextInfo').slice(0, 8) } });
      return;
    }
    let payload: IncomingSupplierMessage = { sessionId: this.sessionId, groupId, messageId, timestampMs: messageTimestampMs, text,
      ...(message.key.participant === undefined ? {} : { participantId: message.key.participant }) };
    try {
      if (image) {
        const bytes = await downloadMediaMessage(message, 'buffer', {}, { logger: baileysLogger, reuploadRequest: (failedMessage) => socket.updateMediaMessage(failedMessage) });
        const expectedAlbumImages = content.albumMessage?.expectedImageCount;
        const mimeType = image.mimetype?.startsWith('image/') ? image.mimetype
          : documentImage && image === documentImage ? documentImageMimeType(documentImage) : undefined;
        payload = { ...payload, image: { bytes, mimeType: mimeType ?? 'image/jpeg', ...(expectedAlbumImages == null ? {} : { expectedAlbumImages }) } };
      }
      if (this.supplierReception) {
        const outcome = await this.supplierReception.capture(payload, upsertType === 'history');
        this.reception = { ...this.reception, lastSupplierResult: outcome === 'stored' ? 'stored' : outcome === 'failed' ? 'error' : outcome === 'pending' ? 'pending' : 'duplicate' };
      } else {
        await this.supplierIngestion.receive(payload);
        this.reception = { ...this.reception, lastSupplierResult: 'stored' };
      }
    } catch (error) {
      this.reception = { ...this.reception, lastSupplierResult: 'error' };
      this.supplierReception?.recordUnsupported(this.sessionId, groupId, messageId, messageTimestampMs, error instanceof Error ? error.message : 'Error desconocido al descargar la publicación.');
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'error', category: 'products', action: 'product.received.failed', entityType: 'whatsapp_group', entityId: groupId, message: 'No se pudo descargar o guardar el mensaje del proveedor', details: { supplierName, errorType: error instanceof Error ? error.name : 'UnknownError' } });
      this.logger.error({ sessionId: this.sessionId, groupId, messageId, err: error }, 'Falló la recepción de un mensaje seleccionado de proveedor');
    }
  }

  private async refreshGroups() {
    const socket = this.socket;
    if (!socket || this.currentStatus !== 'connected') return;
    if (this.groupRefresh?.socket === socket) return this.groupRefresh.promise;
    if (Date.now() < this.nextGroupRefreshAt) return;
    this.nextGroupRefreshAt = Date.now() + 30_000;
    const promise = (async () => {
      try {
        const metadata = await socket.groupFetchAllParticipating();
        if (this.socket !== socket) return;
        this.groups = Object.values(metadata).map((group) => ({ id: group.id, name: group.subject })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        if (this.lastError === 'rate-overlimit') this.lastError = null;
      } catch (error) {
        if (this.socket !== socket) return;
        if (error instanceof Error && error.message === 'rate-overlimit') this.nextGroupRefreshAt = Date.now() + 120_000;
        this.fail(error);
      }
    })();
    this.groupRefresh = { socket, promise };
    try { await promise; }
    finally { if (this.groupRefresh?.promise === promise) this.groupRefresh = undefined; }
  }

  private fail(error: unknown) {
    this.lastError = error instanceof Error ? error.message : 'Error desconocido en Baileys.';
    try {
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'error', category: 'connection', action: 'whatsapp.adapter.error', entityType: 'whatsapp_session', entityId: this.sessionId, message: 'Ocurrió un error en la integración experimental de WhatsApp', details: { errorType: error instanceof Error ? error.name : 'UnknownError', ...(this.lastError === 'rate-overlimit' ? { reason: 'rate-overlimit' } : {}) } });
    } catch (loggingError) {
      this.logger.error({ err: loggingError }, 'No se pudo guardar el error de WhatsApp en el historial local');
    }
    this.logger.error({ err: error }, 'Error del adaptador experimental de WhatsApp');
  }

  private clearStoredSession() {
    this.db.prepare('DELETE FROM whatsapp_auth_records WHERE session_id=?').run(this.sessionId);
  }

  private emptyReceptionDiagnostics(): WhatsAppReceptionDiagnostics {
    return { lastUpsertAt: null, lastUpsertType: null, lastUpsertMessageCount: 0, lastGroupMessageAt: null, lastGroupName: null, lastSupplierMessageAt: null, lastSupplierName: null, lastSupplierResult: null };
  }
}

export class BaileysSessionRegistry {
  private readonly connectors = new Map<string, BaileysConnector>();

  constructor(private readonly db: AppDatabase, private readonly logger: FastifyBaseLogger, private readonly enabled: boolean, private readonly ingestion: SupplierIngestionService, private readonly reception?: SupplierReceptionService) {}

  get(sessionId: string): BaileysConnector | undefined {
    const account = this.db.prepare('SELECT id FROM whatsapp_sessions WHERE id=? AND archived_at IS NULL').get(sessionId);
    if (!account) return undefined;
    let connector = this.connectors.get(sessionId);
    if (!connector) {
      connector = new BaileysConnector(this.db, this.logger, this.enabled, this.ingestion, sessionId, this.reception);
      this.connectors.set(sessionId, connector);
    }
    return connector;
  }

  async connectSavedSessions() {
    if (!this.enabled) return;
    const accounts = this.db.prepare(`SELECT s.id FROM whatsapp_sessions s JOIN whatsapp_auth_records a ON a.session_id=s.id
      WHERE s.archived_at IS NULL AND a.record_type='creds' AND a.record_id='main' ORDER BY s.created_at`).all() as Array<{ id: string }>;
    for (const account of accounts) {
      try { await this.get(account.id)?.connect(); }
      catch (error) { this.logger.error({ sessionId: account.id, err: error }, 'No se pudo reconectar una cuenta de WhatsApp al abrir la aplicación'); }
    }
  }

  async close() {
    await Promise.all([...this.connectors.values()].map((connector) => connector.disconnect()));
    this.connectors.clear();
  }
}
