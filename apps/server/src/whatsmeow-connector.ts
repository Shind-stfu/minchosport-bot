import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDatabase } from './database.js';
import { currentUserProtector, type DataProtector } from './session-protector.js';
import { EncryptedWhatsmeowStorage } from './whatsmeow-storage.js';
import type { IncomingSupplierMessage, SupplierIngestionService } from './supplier-ingestion.js';
import { shouldIngestSupplierMessage, type WhatsAppConnector, type WhatsAppGroup, type WhatsAppReceptionDiagnostics, type WhatsAppReceptionResult, type WhatsAppStatus } from './whatsapp-shared.js';
import { writeApplicationLog } from './application-log.js';
import type { SupplierReceptionService } from './supplier-reception.js';
import { HistoryRecovery, type HistoryMessage, type HistoryMessageKey } from './history-recovery.js';
import { readReceptionSchedule } from './reception-schedule.js';

const DECRYPTION_PENDING = 'WhatsApp no pudo descifrar este mensaje. Se espera una nueva entrega antes de incorporarlo al catálogo.';
const DECRYPTION_PENDING_CODE = 'decrypt_pending';
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const DB_SUFFIXES = ['', '-journal', '-shm', '-wal'];

export type WhatsmeowSidecarEvent = {
  type: 'ready' | 'response' | 'event';
  id?: string;
  event?: string;
  ok?: boolean;
  error?: string;
  retryable?: boolean;
  status?: string;
  qr?: string;
  paired?: boolean;
  groups?: unknown;
  message?: InboundMessage;
  batch?: HistoryBatch;
  messageId?: string;
};
type SidecarEvent = WhatsmeowSidecarEvent;

type InboundMessage = {
  groupId: string;
  messageId: string;
  participantId?: string;
  timestampMs: number;
  fromMe: boolean;
  type: 'notify' | 'history' | 'decrypt-failed';
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  expectedAlbumImages?: number;
  mediaDownloadError?: boolean;
};

type HistoryBatch = { onDemand: boolean; requestId?: string; groupIds: string[]; messages: HistoryMessage[] };
type PendingCommand = { resolve(value: SidecarEvent): void; reject(error: Error): void; timeout: NodeJS.Timeout };
type BridgeProcess = {
  child: { exitCode: number | null; killed: boolean };
  ready: Promise<SidecarEvent>;
  command(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<SidecarEvent>;
  shutdown(): Promise<void>;
};

export type WhatsmeowBridgeFactory = (
  binaryPath: string,
  databasePath: string,
  encryptionKey: string,
  onEvent: (event: SidecarEvent) => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  supplierGroupIds: string[],
) => BridgeProcess;

export type WhatsmeowConnectorDependencies = {
  protector?: DataProtector;
  bridgeFactory?: WhatsmeowBridgeFactory;
};

const QR_EXPIRED_MESSAGE = 'El QR venció. Pulsa Generar otro QR para iniciar un código nuevo.';

class WhatsmeowBridgeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingCommand>();
  private readyResolve: ((event: SidecarEvent) => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  readonly ready: Promise<SidecarEvent>;

  constructor(binaryPath: string, databasePath: string, encryptionKey: string, private readonly onEvent: (event: SidecarEvent) => void, private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void, supplierGroupIds: string[]) {
    this.child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ready = new Promise((resolveReady, rejectReady) => { this.readyResolve = resolveReady; this.readyReject = rejectReady; });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.receive(line));
    // Bridge diagnostics stay private to the child. It is configured without a protocol logger.
    this.child.stderr.on('data', () => {});
    this.child.once('error', (error) => {
      this.readyReject?.(error);
      this.rejectPending(error);
    });
    this.child.once('exit', (code, signal) => {
      const error = new Error(`El proceso whatsmeow terminó${code === null ? '' : ` (código ${code})`}.`);
      this.readyReject?.(error);
      this.rejectPending(error);
      this.onExit(code, signal);
    });
    this.child.stdin.write(`${JSON.stringify({ type: 'initialize', databasePath, encryptionKey, supplierGroupIds })}\n`);
  }

  async command(type: string, payload: Record<string, unknown> = {}, timeoutMs = 100_000): Promise<SidecarEvent> {
    const id = randomUUID();
    const response = new Promise<SidecarEvent>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`La operación de whatsmeow agotó el tiempo de espera (${type}).`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timeout });
    });
    this.child.stdin.write(`${JSON.stringify({ ...payload, type, id })}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    const result = await response;
    if (!result.ok) throw Object.assign(new Error(result.error ?? `Falló la operación whatsmeow: ${type}.`), { retryable: result.retryable === true });
    return result;
  }

  async shutdown() {
    if (this.child.exitCode !== null || this.child.killed) return;
    try { await this.command('shutdown', {}, 2_000); } catch { /* The process may already be stopping. */ }
    await new Promise<void>((resolveDone) => {
      if (this.child.exitCode !== null) return resolveDone();
      const timeout = setTimeout(() => { this.child.kill(); resolveDone(); }, 2_000);
      timeout.unref();
      this.child.once('exit', () => { clearTimeout(timeout); resolveDone(); });
    });
  }

  private receive(line: string) {
    let event: SidecarEvent;
    try { event = JSON.parse(line) as SidecarEvent; }
    catch { return; }
    if (event.type === 'ready') {
      this.readyResolve?.(event);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (event.type === 'response' && event.id) {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id);
      clearTimeout(pending.timeout);
      pending.resolve(event);
      return;
    }
    if (event.type === 'event') this.onEvent(event);
  }

  private rejectPending(error: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** whatsmeow adapter. WhatsApp sessions live in a per-account SQLCipher store. */
export class WhatsmeowConnector implements WhatsAppConnector {
  private currentStatus: WhatsAppStatus = 'disconnected';
  private qr: string | null = null;
  private lastError: string | null = null;
  private groups: WhatsAppGroup[] = [];
  private bridge: BridgeProcess | undefined;
  private bridgeStarting: Promise<BridgeProcess> | undefined;
  private starting = false;
  private keepConnected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private libraryReconnectPending = false;
  private groupRefresh: Promise<WhatsAppGroup[]> | undefined;
  private nextGroupRefreshAt = 0;
  private liveSinceMs = 0;
  private historyRecovery: HistoryRecovery | undefined;
  private messageQueue = Promise.resolve();
  private reception: WhatsAppReceptionDiagnostics = this.emptyReceptionDiagnostics();

  constructor(
    private readonly db: AppDatabase,
    private readonly dataDirectory: string,
    private readonly logger: FastifyBaseLogger,
    private readonly enabled: boolean,
    private readonly supplierIngestion?: SupplierIngestionService,
    readonly sessionId = 'main',
    private readonly supplierReception?: SupplierReceptionService,
    private readonly dependencies: WhatsmeowConnectorDependencies = {},
  ) {}

  status() {
    return { status: this.enabled ? this.currentStatus : 'disabled' as const, qr: this.qr, lastError: this.lastError,
      reconnectScheduled: Boolean(this.reconnectTimer) || this.libraryReconnectPending, reception: { ...this.reception } };
  }

  async connect() {
    if (!this.enabled) throw new Error('La integración está deshabilitada. Activa WHATSAPP_ENABLED=true para habilitarla.');
    this.keepConnected = true;
    this.clearReconnectTimer();
    if (this.starting || this.currentStatus === 'connected' || this.currentStatus === 'connecting' || this.currentStatus === 'qr') return;
    this.starting = true;
    this.currentStatus = 'connecting';
    this.libraryReconnectPending = false;
    this.qr = null;
    this.lastError = null;
    this.reception = this.emptyReceptionDiagnostics();
    this.nextGroupRefreshAt = 0;
    this.liveSinceMs = Math.floor(Date.now() / 1000) * 1000;
    let bridge: BridgeProcess | undefined;
    try {
      bridge = await this.ensureBridge();
      await bridge.command('connect');
    } catch (error) {
      this.currentStatus = 'disconnected';
      this.lastError = error instanceof Error ? error.message : 'No se pudo iniciar whatsmeow.';
      this.recordAdapterError(error);
      const paired = this.hasPairedMarker();
      const retryable = error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === true;
      // whatsmeow retries network failures for saved sessions. For a new
      // pairing, retry only transient dial failures so the QR can still appear
      // after a temporary network reset; permanent errors stay user-visible.
      if (bridge && (paired || retryable)) {
        if (!paired) this.lastError = 'La conexión inicial falló por un error temporal; se volverá a intentar automáticamente.';
        this.scheduleReconnect();
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async regenerateQr() {
    if (this.currentStatus !== 'qr' || this.starting) throw new Error('Espera a que aparezca un QR antes de solicitar otro.');
    this.keepConnected = false;
    this.libraryReconnectPending = false;
    this.clearReconnectTimer();
    await this.stopBridge();
    this.qr = null;
    this.currentStatus = 'disconnected';
    this.lastError = null;
    await this.connect();
  }

  /** Restore paired native stores even if the app crashed before saving its paired marker. */
  async connectSavedSession() {
    if (!this.enabled) return false;
    if (this.hasPairedMarker()) {
      await this.connect();
      return true;
    }
    if (!existsSync(this.storePath())) return false;

    const bridge = await this.ensureBridge();
    const ready = await bridge.ready;
    if (!ready.paired) {
      this.historyRecovery?.stop();
      this.historyRecovery = undefined;
      await this.stopBridge();
      return false;
    }
    await this.connect();
    return true;
  }

  async disconnect() {
    this.keepConnected = false;
    this.reconnectAttempts = 0;
    this.libraryReconnectPending = false;
    this.clearReconnectTimer();
    const bridge = this.bridge;
    this.historyRecovery?.stop(true);
    this.historyRecovery = undefined;
    this.qr = null;
    this.currentStatus = 'disconnected';
    this.lastError = null;
    this.groups = [];
    if (bridge) {
      try { await bridge.command('disconnect', {}, 15_000); }
      catch (error) { this.logger.warn({ sessionId: this.sessionId, err: error }, 'No se pudo confirmar la desconexión de whatsmeow'); }
    }
  }

  async resetSession() {
    if (this.currentStatus === 'connected' || this.currentStatus === 'connecting' || this.starting) {
      throw new Error('Desconecta la sesión antes de restablecer la vinculación.');
    }
    this.keepConnected = false;
    this.reconnectAttempts = 0;
    this.libraryReconnectPending = false;
    this.clearReconnectTimer();
    this.historyRecovery?.stop();
    this.historyRecovery = undefined;
    this.qr = null;
    this.currentStatus = 'disconnected';
    this.lastError = null;
    this.groups = [];
    await this.stopBridge();
    this.clearStoredSession();
  }

  async close() {
    this.keepConnected = false;
    this.libraryReconnectPending = false;
    this.clearReconnectTimer();
    this.historyRecovery?.stop(true);
    this.historyRecovery = undefined;
    await this.stopBridge();
  }

  async listGroups() {
    if (this.currentStatus !== 'connected') return this.groups;
    return this.refreshGroups();
  }

  async requestHistory() {
    if (!this.enabled || this.currentStatus !== 'connected' || !this.historyRecovery) throw new Error('Conecta WhatsApp antes de solicitar la recuperación del historial.');
    if (!this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL LIMIT 1').get(this.sessionId)) throw new Error('Agrega un proveedor antes de solicitar su historial.');
    this.historyRecovery.start();
  }

  async syncSupplierGroups() {
    const bridge = this.bridge;
    if (!bridge || bridge.child.exitCode !== null) return;
    try {
      await bridge.command('supplier-groups', { supplierGroupIds: this.activeSupplierGroupIds() }, 15_000);
    } catch (error) {
      this.recordAdapterError(error);
    }
  }

  async sendImage(groupId: string, bytes: Buffer, mimeType: string, caption?: string) {
    if (!this.enabled || this.currentStatus !== 'connected' || !this.bridge) throw new Error('WhatsApp no está conectado para publicar.');
    const settings = this.db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(this.sessionId) as { target_group_ids: string } | undefined;
    const targets = JSON.parse(settings?.target_group_ids ?? '[]') as string[];
    const isSource = this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId);
    const hasFrozenPublication = this.db.prepare(`SELECT 1 FROM outbound_publications p JOIN outbound_units u ON u.publication_id=p.id
      WHERE p.session_id=? AND p.group_id=? AND p.status='in_progress' AND u.status='transmitting' LIMIT 1`).get(this.sessionId, groupId);
    if ((!targets.includes(groupId) && !hasFrozenPublication) || isSource) throw new Error('El grupo no está habilitado como destino de publicación.');
    const response = await this.bridge.command('send-image', { groupId, imageBase64: bytes.toString('base64'), mimeType, caption }, 120_000);
    if (!response.messageId) throw new Error('whatsmeow no devolvió el identificador de la unidad publicada.');
    return { messageId: response.messageId };
  }

  private async ensureBridge(): Promise<BridgeProcess> {
    if (this.bridge && this.bridge.child.exitCode === null) return this.bridge;
    if (this.bridgeStarting) return this.bridgeStarting;
    const starting = (async () => {
      const auth = await EncryptedWhatsmeowStorage.create(this.db, this.dependencies.protector ?? currentUserProtector(), this.sessionId);
      const databasePath = this.storePath();
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      const binaryPath = this.binaryPath();
      let bridge!: BridgeProcess;
      const bridgeFactory = this.dependencies.bridgeFactory ?? ((...args) => new WhatsmeowBridgeProcess(...args));
      bridge = bridgeFactory(binaryPath, databasePath, auth.keyHex(),
        (event) => { void this.handleBridgeEvent(event, bridge).catch((error: unknown) => this.recordAdapterError(error)); },
        (code, signal) => { void this.handleBridgeExit(bridge, code, signal); }, this.activeSupplierGroupIds());
      this.bridge = bridge;
      try {
        const ready = await bridge.ready;
        if (ready.paired) this.savePairedMarker(auth);
        this.historyRecovery = this.createHistoryRecovery();
        return bridge;
      } catch (error) {
        if (this.bridge === bridge) this.bridge = undefined;
        await bridge.shutdown();
        throw error;
      }
    })();
    this.bridgeStarting = starting;
    try { return await starting; }
    finally { if (this.bridgeStarting === starting) this.bridgeStarting = undefined; }
  }

  private async handleBridgeEvent(event: SidecarEvent, bridge: BridgeProcess) {
    if (this.bridge !== bridge) return;
    switch (event.event) {
      case 'qr':
        if (event.qr) {
          this.qr = event.qr;
          this.currentStatus = 'qr';
          this.writeLog('whatsapp.qr.generated', 'Se generó un QR para vincular WhatsApp. El código no se guarda en el historial');
        }
        break;
      case 'qr-expired':
        if (!this.keepConnected || this.hasPairedMarker()) break;
        this.qr = null;
        this.currentStatus = 'disconnected';
        this.lastError = QR_EXPIRED_MESSAGE;
        this.writeLog('whatsapp.qr.expired', 'El QR de vinculación venció');
        break;
      case 'paired':
        this.savePairedMarker(await EncryptedWhatsmeowStorage.create(this.db, this.dependencies.protector ?? currentUserProtector(), this.sessionId));
        this.qr = null;
        this.currentStatus = 'connecting';
        this.writeLog('whatsapp.session.paired', 'WhatsApp aceptó el QR; completando el inicio de sesión');
        break;
      case 'connected':
        this.reconnectAttempts = 0;
        this.libraryReconnectPending = false;
        this.nextGroupRefreshAt = 0;
        this.currentStatus = 'connected';
        this.qr = null;
        this.lastError = null;
        this.savePairedMarker(await EncryptedWhatsmeowStorage.create(this.db, this.dependencies.protector ?? currentUserProtector(), this.sessionId));
        this.logger.info({ sessionId: this.sessionId }, 'Sesión whatsmeow conectada');
        this.writeLog('whatsapp.session.connected', 'La sesión de WhatsApp quedó conectada');
        await this.syncSupplierGroups();
        this.beginRecovery();
        if (this.historyRecovery && this.hasSuppliers()) this.historyRecovery.start(false);
        void this.listGroups().catch((error: unknown) => this.recordAdapterError(error));
        break;
      case 'disconnected':
        this.qr = null;
        this.currentStatus = 'disconnected';
        this.libraryReconnectPending = !event.error && this.keepConnected && this.hasPairedMarker();
        this.lastError = event.error ?? (this.keepConnected && this.hasPairedMarker() ? 'WhatsApp se desconectó; whatsmeow está intentando reconectar.' : this.lastError === QR_EXPIRED_MESSAGE ? QR_EXPIRED_MESSAGE : null);
        this.historyRecovery?.stop(true);
        this.writeLog('whatsapp.session.disconnected', 'La conexión de WhatsApp se cerró', event.error ? { reason: 'remote_disconnect' } : undefined, 'warning');
        break;
      case 'logged-out':
        this.qr = null;
        this.libraryReconnectPending = false;
        this.currentStatus = 'logged_out';
        this.lastError = 'WhatsApp cerró la sesión guardada. Genera un QR nuevo para volver a vincular.';
        this.historyRecovery?.stop(true);
        this.writeLog('whatsapp.session.logged_out', 'WhatsApp cerró la sesión vinculada. Es necesario volver a conectarla', undefined, 'warning');
        await this.clearNativeStore();
        break;
      case 'connection-error':
        this.libraryReconnectPending = false;
        this.lastError = event.error ?? 'Ocurrió un error de conexión de WhatsApp.';
        if (this.currentStatus !== 'qr') this.currentStatus = 'disconnected';
        this.writeLog('whatsapp.adapter.error', 'Ocurrió un error en la integración de WhatsApp', { errorType: 'WhatsmeowConnectionError' }, 'warning');
        break;
      case 'groups-updated':
        if (this.currentStatus === 'connected') void this.refreshGroups().catch((error: unknown) => this.recordAdapterError(error));
        break;
      case 'history-batch':
        if (event.batch) this.observeHistoryBatch(event.batch);
        break;
      case 'message':
        if (event.message) this.enqueueMessage(event.message);
        break;
    }
  }

  private observeHistoryBatch(batch: HistoryBatch) {
    const supplierGroups = new Set((this.db.prepare('SELECT source_group_id FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL').all(this.sessionId) as Array<{ source_group_id: string }>).map((row) => row.source_group_id));
    const supplierMessages = batch.messages.filter((message) => typeof message.key.remoteJid === 'string' && !message.key.fromMe && supplierGroups.has(message.key.remoteJid));
    const schedule = readReceptionSchedule(this.db, this.sessionId);
    const nowMs = Date.now();
    writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.batch.delivered', entityType: 'whatsapp_session', entityId: this.sessionId,
      message: 'WhatsApp entregó un lote de historial para evaluar', details: { syncType: batch.onDemand ? 'ON_DEMAND' : 'SYNC', messageCount: batch.messages.length,
        requestId: batch.requestId ?? null, supplierMessageCount: supplierMessages.length,
        inRecoveryWindow: supplierMessages.filter((message) => shouldIngestSupplierMessage('history', Number(message.messageTimestamp) * 1000, nowMs, schedule, this.liveSinceMs)).length,
        chatCount: batch.groupIds.length } });
    this.historyRecovery?.observe(batch.messages, batch.onDemand, batch.requestId);
    this.reception = { ...this.reception, lastUpsertAt: new Date().toISOString(), lastUpsertType: 'append', lastUpsertMessageCount: batch.messages.length };
  }

  private enqueueMessage(message: InboundMessage) {
    this.messageQueue = this.messageQueue.then(async () => {
      if (this.bridge === undefined || !this.supplierIngestion) return;
      if (message.type !== 'history') {
        this.reception = { ...this.reception, lastUpsertAt: new Date().toISOString(), lastUpsertType: 'notify', lastUpsertMessageCount: 1 };
      }
      if (message.type !== 'history' && message.type !== 'decrypt-failed') this.historyRecovery?.observe([this.toHistoryReference(message)]);
      if (message.type === 'history' && !message.fromMe && this.supplierIngestion.isSupplierGroup(message.groupId, this.sessionId)
        && this.acceptsMessage('history', message.timestampMs)) {
        await this.supplierReception?.recordHistoryBatch(this.sessionId,
          message.groupId && message.messageId ? [{ groupId: message.groupId, messageId: message.messageId }] : []);
      }
      await this.handleSupplierMessage(message);
      if (message.type === 'history') await this.supplierReception?.scheduleChanged(this.sessionId);
    }).catch((error: unknown) => this.recordAdapterError(error));
  }

  private async handleSupplierMessage(message: InboundMessage) {
    const { groupId, messageId, timestampMs } = message;
    if (!groupId.endsWith('@g.us') || message.fromMe || !messageId || !this.supplierIngestion?.isSupplierGroup(groupId, this.sessionId)) return;
    const groupName = (this.db.prepare('SELECT subject FROM whatsapp_groups WHERE session_id=? AND jid=?').get(this.sessionId, groupId) as { subject: string } | undefined)?.subject ?? groupId;
    const supplierName = (this.db.prepare('SELECT name FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId) as { name: string } | undefined)?.name ?? groupName;
    const at = new Date().toISOString();
    this.reception = { ...this.reception, lastGroupMessageAt: at, lastGroupName: groupName, lastSupplierMessageAt: at, lastSupplierName: supplierName, lastSupplierResult: 'processing' };
    const upsertType = message.type === 'history' ? 'history' : 'notify';
    if (!this.acceptsMessage(upsertType, timestampMs)) {
      if (Number.isFinite(timestampMs) && Date.now() - timestampMs <= MAX_RECOVERY_AGE_MS && timestampMs <= Date.now()) {
        this.reception = { ...this.reception, lastSupplierResult: 'outside_recovery_window' };
        this.writeLog('product.received.outside_recovery_window', 'Se omitió una publicación fuera del día o rango de recuperación', { supplierName, upsertType, ...readReceptionSchedule(this.db, this.sessionId) }, 'info', 'products', 'whatsapp_group', groupId);
      } else {
        this.reception = { ...this.reception, lastSupplierResult: 'older_message_skipped' };
        this.writeLog('product.received.too_old', 'Se omitió un mensaje del proveedor con más de 24 horas', { supplierName, upsertType }, 'warning', 'products', 'whatsapp_group', groupId);
      }
      return;
    }
    const inbox = this.db.prepare('SELECT status,error FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(this.sessionId, groupId, messageId) as { status: string; error: string | null } | undefined;
    const ledger = this.db.prepare('SELECT 1 FROM whatsapp_source_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(this.sessionId, groupId, messageId);
    if (ledger || inbox && inbox.status !== 'failed') {
      this.reception = { ...this.reception, lastSupplierResult: inbox?.status === 'pending' ? 'pending' : 'duplicate' };
      return;
    }
    if (message.type === 'decrypt-failed') {
      this.reception = { ...this.reception, lastSupplierResult: 'error' };
      if (inbox?.error !== DECRYPTION_PENDING) {
        this.supplierReception?.recordUnsupported(this.sessionId, groupId, messageId, timestampMs, DECRYPTION_PENDING_CODE);
        this.writeLog('supplier.message.decrypt.failed', 'No se pudo descifrar una publicación del proveedor. whatsmeow solicitará una nueva entrega automáticamente.', { messageId }, 'warning', 'connection', 'whatsapp_group', groupId);
      }
      return;
    }
    if (message.mediaDownloadError) {
      this.reception = { ...this.reception, lastSupplierResult: 'error' };
      this.supplierReception?.recordUnsupported(this.sessionId, groupId, messageId, timestampMs, 'media_download_failed');
      this.writeLog('product.received.failed', 'No se pudo descargar o guardar el mensaje del proveedor', { messageId, stage: 'media_download', errorType: 'MediaDownloadError' }, 'error', 'products', 'whatsapp_group', groupId);
      return;
    }
    const text = message.text ?? '';
    if (!text.trim() && !message.imageBase64) {
      this.reception = { ...this.reception, lastSupplierResult: 'unsupported_message' };
      this.writeLog('product.received.unsupported', 'Se omitió un mensaje del proveedor que no contiene texto ni fotografía compatible', { supplierName }, 'warning', 'products', 'whatsapp_group', groupId);
      return;
    }
    let payload: IncomingSupplierMessage = { sessionId: this.sessionId, groupId, messageId, timestampMs, text,
      receptionMode: message.type === 'history' || timestampMs < this.liveSinceMs ? 'recovery' : 'live',
      ...(message.participantId === undefined ? {} : { participantId: message.participantId }) };
    if (message.imageBase64) {
      payload = { ...payload, image: { bytes: Buffer.from(message.imageBase64, 'base64'), mimeType: message.mimeType?.startsWith('image/') ? message.mimeType : 'image/jpeg',
        ...(message.expectedAlbumImages == null ? {} : { expectedAlbumImages: message.expectedAlbumImages }) } };
    }
    try {
      if (this.supplierReception) {
        const outcome = await this.supplierReception.capture(payload, message.type === 'history');
        this.reception = { ...this.reception, lastSupplierResult: this.resultFor(outcome) };
        if (outcome === 'stored' && inbox?.error === DECRYPTION_PENDING) this.writeLog('supplier.message.decrypt.recovered', 'WhatsApp volvió a entregar la publicación descifrada y se incorporó al catálogo', { messageId }, 'info', 'connection', 'whatsapp_group', groupId);
      } else {
        await this.supplierIngestion?.receive(payload);
        this.reception = { ...this.reception, lastSupplierResult: 'stored' };
      }
    } catch (error) {
      this.reception = { ...this.reception, lastSupplierResult: 'error' };
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      this.supplierReception?.recordUnsupported(this.sessionId, groupId, messageId, timestampMs, 'processing_failed');
      this.writeLog('product.received.failed', 'No se pudo descargar o guardar el mensaje del proveedor', { messageId, errorType, stage: 'processing' }, 'error', 'products', 'whatsapp_group', groupId);
      this.logger.error({ sessionId: this.sessionId, groupId, messageId, errorType }, 'Falló la recepción de una publicación whatsmeow');
    }
  }

  private async beginRecovery() {
    if (!this.supplierReception || !this.hasSuppliers()) return;
    this.supplierReception.beginRecovery(this.sessionId);
  }

  private createHistoryRecovery() {
    if (!this.supplierIngestion) return undefined;
    return new HistoryRecovery(this.db, this.sessionId, async (count, key: HistoryMessageKey, timestampMs, attemptId) => {
      const bridge = this.bridge;
      if (!bridge || this.currentStatus !== 'connected' || !key.remoteJid || !key.id) throw new Error('WhatsApp se desconectó o falta una referencia para solicitar historial.');
      const requestId = randomUUID();
      await bridge.command('history', { requestId, attemptId, groupId: key.remoteJid, messageId: key.id, timestampSec: Math.floor(timestampMs / 1000), fromMe: Boolean(key.fromMe), count }, 30_000);
      return requestId;
    }, this.supplierReception, 1);
  }

  private async handleBridgeExit(bridge: BridgeProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (this.bridge !== bridge) return;
    this.bridge = undefined;
    this.libraryReconnectPending = false;
    this.historyRecovery?.stop(true);
    this.historyRecovery = undefined;
    this.currentStatus = 'disconnected';
    this.qr = null;
    const canReconnect = this.keepConnected && this.hasPairedMarker();
    this.lastError = canReconnect
      ? 'El proceso de WhatsApp se cerró; se intentará restablecer la conexión.'
      : 'El proceso de WhatsApp se cerró. Pulsa Conectar con QR para volver a intentarlo.';
    this.writeLog('whatsapp.bridge.exited', 'El proceso de conexión de WhatsApp se cerró', { exitCode: code, signal, reconnectScheduled: canReconnect }, 'warning');
    if (canReconnect) this.scheduleReconnect();
  }

  private async refreshGroups(): Promise<WhatsAppGroup[]> {
    if (this.currentStatus !== 'connected') return this.groups;
    if (this.groupRefresh) return this.groupRefresh;
    if (Date.now() < this.nextGroupRefreshAt) return this.groups;
    this.nextGroupRefreshAt = Date.now() + 30_000;
    const refresh = (async () => {
      const bridge = await this.ensureBridge();
      const response = await bridge.command('groups', {}, 45_000);
      const groups = Array.isArray(response.groups) ? response.groups as Array<{ id: string; name: string }> : [];
      this.groups = groups.filter((group) => typeof group.id === 'string').map((group) => ({ id: group.id, name: group.name || group.id }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const upsert = this.db.prepare(`INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(session_id,jid) DO UPDATE SET subject=excluded.subject,updated_at=excluded.updated_at`);
      const updatedAt = new Date().toISOString();
      this.db.transaction(() => { for (const group of this.groups) upsert.run(this.sessionId, group.id, group.name, updatedAt); })();
      return this.groups;
    })();
    this.groupRefresh = refresh;
    try { return await refresh; }
    catch (error) {
      this.nextGroupRefreshAt = Date.now() + 120_000;
      throw error;
    } finally {
      if (this.groupRefresh === refresh) this.groupRefresh = undefined;
    }
  }

  private activeSupplierGroupIds() {
    return (this.db.prepare('SELECT source_group_id FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL ORDER BY source_group_id').all(this.sessionId) as Array<{ source_group_id: string }>).map((row) => row.source_group_id);
  }

  private scheduleReconnect() {
    if (!this.keepConnected || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.keepConnected || this.starting) return;
      void this.connect().catch((error: unknown) => {
        this.logger.warn({ sessionId: this.sessionId, err: error }, 'Falló el reinicio del cliente whatsmeow');
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private async stopBridge() {
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) await bridge.shutdown();
  }

  private binaryPath() {
    const configured = process.env.WHATSMEOW_BINARY;
    if (configured) return resolve(configured);
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform;
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
    const filename = `whatsmeow-bridge-${platform}-${architecture}${process.platform === 'win32' ? '.exe' : ''}`;
    const packageDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(packageDirectory, '..', 'whatsmeow', 'bin', filename), join(process.cwd(), 'whatsmeow', 'bin', filename), join(process.cwd(), 'apps', 'server', 'whatsmeow', 'bin', filename)];
    const binary = candidates.find(existsSync);
    if (!binary) throw new Error('No se encontró el ejecutable whatsmeow. Ejecuta pnpm --filter @tenis/server build:whatsmeow y vuelve a iniciar.');
    return binary;
  }

  private storePath() {
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(this.sessionId)) throw new Error('El identificador de la cuenta no es válido para el almacén whatsmeow.');
    return join(this.dataDirectory, 'whatsmeow', `${this.sessionId}.sqlite`);
  }

  private hasSuppliers() {
    return Boolean(this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL LIMIT 1').get(this.sessionId));
  }

  private acceptsMessage(type: 'notify' | 'append' | 'history', timestampMs: number) {
    return shouldIngestSupplierMessage(type, timestampMs, Date.now(), readReceptionSchedule(this.db, this.sessionId), this.liveSinceMs);
  }

  private toHistoryReference(message: InboundMessage): HistoryMessage {
    return { key: { remoteJid: message.groupId, id: message.messageId, fromMe: message.fromMe, ...(message.participantId ? { participant: message.participantId } : {}) }, messageTimestamp: Math.floor(message.timestampMs / 1000) };
  }

  private resultFor(outcome: 'stored' | 'failed' | 'pending' | 'outside_window' | 'duplicate'): WhatsAppReceptionResult {
    return outcome === 'stored' ? 'stored' : outcome === 'failed' ? 'error' : outcome === 'pending' ? 'pending' : outcome === 'outside_window' ? 'outside_recovery_window' : 'duplicate';
  }

  private savePairedMarker(auth: EncryptedWhatsmeowStorage) {
    this.db.prepare(`INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES (?,'whatsmeow-state','paired',?)
      ON CONFLICT(session_id,record_type,record_id) DO UPDATE SET ciphertext=excluded.ciphertext`)
      .run(this.sessionId, auth.encrypt({ engine: 'whatsmeow', paired: true }));
  }

  private hasPairedMarker() {
    return Boolean(this.db.prepare("SELECT 1 FROM whatsapp_auth_records WHERE session_id=? AND record_type='whatsmeow-state' AND record_id='paired'").get(this.sessionId));
  }

  private clearStoredSession() {
    this.db.prepare('DELETE FROM whatsapp_auth_records WHERE session_id=?').run(this.sessionId);
    this.removeNativeStoreFiles();
  }

  private async clearNativeStore() {
    await this.stopBridge();
    this.clearStoredSession();
  }

  private removeNativeStoreFiles() {
    const path = this.storePath();
    for (const suffix of DB_SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
  }

  private recordAdapterError(error: unknown) {
    this.lastError = error instanceof Error ? error.message : 'Error desconocido en whatsmeow.';
    this.writeLog('whatsapp.adapter.error', 'Ocurrió un error en la integración de WhatsApp', { errorType: error instanceof Error ? error.name : 'UnknownError' }, 'error');
    this.logger.error({ sessionId: this.sessionId, err: error }, 'Error del adaptador whatsmeow');
  }

  private writeLog(action: string, message: string, details?: Record<string, unknown>, level: 'info' | 'warning' | 'error' = 'info', category = 'connection', entityType = 'whatsapp_session', entityId = this.sessionId) {
    writeApplicationLog(this.db, { sessionId: this.sessionId, level, category, action, entityType, entityId, message, ...(details ? { details } : {}) });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emptyReceptionDiagnostics(): WhatsAppReceptionDiagnostics {
    return { lastUpsertAt: null, lastUpsertType: null, lastUpsertMessageCount: 0, lastGroupMessageAt: null, lastGroupName: null, lastSupplierMessageAt: null, lastSupplierName: null, lastSupplierResult: null };
  }
}

export class WhatsmeowSessionRegistry {
  private readonly connectors = new Map<string, WhatsmeowConnector>();

  constructor(private readonly db: AppDatabase, private readonly dataDirectory: string, private readonly logger: FastifyBaseLogger, private readonly enabled: boolean, private readonly ingestion: SupplierIngestionService, private readonly reception?: SupplierReceptionService) {}

  get(sessionId: string): WhatsmeowConnector | undefined {
    const account = this.db.prepare('SELECT id FROM whatsapp_sessions WHERE id=? AND archived_at IS NULL').get(sessionId);
    if (!account) return undefined;
    let connector = this.connectors.get(sessionId);
    if (!connector) {
      connector = new WhatsmeowConnector(this.db, this.dataDirectory, this.logger, this.enabled, this.ingestion, sessionId, this.reception);
      this.connectors.set(sessionId, connector);
    }
    return connector;
  }

  async connectSavedSessions() {
    if (!this.enabled) return;
    const accounts = this.db.prepare('SELECT id FROM whatsapp_sessions WHERE archived_at IS NULL ORDER BY created_at').all() as Array<{ id: string }>;
    for (const account of accounts) {
      try { await this.get(account.id)?.connectSavedSession(); }
      catch (error) { this.logger.error({ sessionId: account.id, err: error }, 'No se pudo reconectar una cuenta whatsmeow al abrir la aplicación'); }
    }
  }

  async close() {
    await Promise.all([...this.connectors.values()].map((connector) => connector.close()));
    this.connectors.clear();
  }
}
