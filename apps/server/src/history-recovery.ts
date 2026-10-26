import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { AppDatabase } from './database.js';
import type { SupplierReceptionService } from './supplier-reception.js';
import { readReceptionSchedule, recoveryEndTimestampMs, recoveryStartTimestampMs } from './reception-schedule.js';
import { writeApplicationLog } from './application-log.js';

const PAGE_SIZE = 50;
const MAX_PAGES_PER_GROUP = 20;
const REQUEST_INTERVAL_MS = 1000;
type Cursor = { groupId: string; messageId: string; timestampMs: number; fromMe: number; participantId: string | null };
type GroupRequest = { cursor: Cursor | undefined; upperBoundMs: number; requestIds: Set<string>; sentCursors: Set<string>; earlyPages: Map<string, Cursor[]>; awaitingAck: boolean; pages: number; pending: boolean; done: boolean; requested: boolean; failed: boolean };

/** Requests older messages using real group/message keys; never invent an anchor. */
export class HistoryRecovery {
  private readonly groups = new Map<string, GroupRequest>();
  private readonly queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  private active = false;
  private revision = 0;
  private startMs = 0;
  private endMs = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly sessionId: string,
    private readonly fetchHistory: (count: number, key: WAMessageKey, timestampMs: number) => Promise<string>,
    private readonly reception?: SupplierReceptionService,
  ) {}

  start(resetStatus = true) {
    this.stop();
    this.active = true;
    this.startMs = recoveryStartTimestampMs(readReceptionSchedule(this.db, this.sessionId));
    this.endMs = Math.min(Date.now(), recoveryEndTimestampMs(readReceptionSchedule(this.db, this.sessionId)));
    if (this.startMs > Date.now()) {
      this.reception?.beginRecovery(this.sessionId);
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, this.startMs - Date.now());
      this.timer.unref();
      return;
    }
    if (resetStatus) this.reception?.beginRecovery(this.sessionId);
    const suppliers = this.db.prepare('SELECT source_group_id as groupId FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL').all(this.sessionId) as Array<{ groupId: string }>;
    for (const { groupId } of suppliers) {
      this.groups.set(groupId, this.groupRequest(this.anchor(groupId)));
      this.enqueue(groupId);
    }
    this.report();
    void this.pump();
  }

  stop() {
    this.revision += 1;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.groups.clear(); this.queue.length = 0;
    this.pumping = false;
  }

  observe(messages: WAMessage[], onDemand = false, requestId?: string | null) {
    const grouped = new Map<string, Cursor[]>();
    for (const message of messages) {
      const groupId = message.key.remoteJid;
      const timestampMs = Number(message.messageTimestamp) * 1000;
      if (!groupId?.endsWith('@g.us') || !message.key.id || !Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > Date.now() + 300_000) continue;
      // Pairing can deliver the last group messages before suppliers are configured.
      // Retain only the real key/timestamp; catalog ingestion and requests still
      // require an active supplier, and message bodies are never stored here.
      const cursor: Cursor = { groupId, messageId: message.key.id, timestampMs, fromMe: message.key.fromMe ? 1 : 0, participantId: message.key.participant ?? null };
      this.db.prepare(`INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms,from_me,participant_jid)
        VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,group_jid) DO UPDATE SET message_id=excluded.message_id,message_timestamp_ms=excluded.message_timestamp_ms,
        from_me=excluded.from_me,participant_jid=excluded.participant_jid WHERE excluded.message_timestamp_ms>whatsapp_history_anchors.message_timestamp_ms`)
        .run(this.sessionId, groupId, cursor.messageId, timestampMs, cursor.fromMe, cursor.participantId);
      if (this.groups.has(groupId)) grouped.set(groupId, [...(grouped.get(groupId) ?? []), cursor]);
    }
    if (!this.active) return;
    for (const [groupId, batch] of grouped) {
      let state = this.groups.get(groupId);
      if (!state) continue;
      const latest = this.anchor(groupId);
      // A persisted cursor can predate the end of the range. A newer event lets
      // us cover the missing upper part instead of only fetching older photos.
      if (latest && state.cursor && state.upperBoundMs < this.endMs && latest.timestampMs > state.upperBoundMs) {
        state = this.groupRequest(latest);
        this.groups.set(groupId, state);
        this.enqueue(groupId);
      }
      if (state.done) continue;
      if (!state.cursor) {
        state.cursor = latest; state.upperBoundMs = latest?.timestampMs ?? 0;
        this.enqueue(groupId);
      } else if (onDemand && state.pending) {
        if (!requestId || state.requestIds.has(requestId)) this.acceptPage(groupId, state, batch);
        else if (state.awaitingAck) state.earlyPages.set(requestId, batch);
      }
    }
    this.report();
    void this.pump();
  }

  private anchor(groupId: string): Cursor | undefined {
    return this.db.prepare(`SELECT group_jid as groupId,message_id as messageId,message_timestamp_ms as timestampMs,from_me as fromMe,participant_jid as participantId
      FROM whatsapp_history_anchors WHERE session_id=? AND group_jid=? AND message_timestamp_ms>=?`)
      .get(this.sessionId, groupId, this.startMs) as Cursor | undefined;
  }

  private groupRequest(cursor: Cursor | undefined): GroupRequest {
    return { cursor, upperBoundMs: cursor?.timestampMs ?? 0, requestIds: new Set(), sentCursors: new Set(), earlyPages: new Map(), awaitingAck: false, pages: 0, pending: false, done: false, requested: false, failed: false };
  }

  private acceptPage(groupId: string, state: GroupRequest, batch: Cursor[]) {
    const cursor = state.cursor;
    if (!cursor) return;
    const candidates = batch.filter((item) => item.timestampMs <= cursor.timestampMs && !state.sentCursors.has(`${item.timestampMs}:${item.messageId}`));
    // Repeated pages must not trigger a request loop, including equal timestamps.
    if (!candidates.length) return;
    const oldest = candidates.reduce((a, b) => a.timestampMs < b.timestampMs ? a : b);
    state.pending = false; state.cursor = oldest;
    if (oldest.timestampMs < this.startMs) state.done = true;
    else if (state.pages >= MAX_PAGES_PER_GROUP) { state.done = true; state.failed = true; }
    else this.enqueue(groupId);
  }

  private enqueue(groupId: string) {
    const state = this.groups.get(groupId);
    if (state?.cursor && !state.pending && !state.done && !this.queue.includes(groupId) && this.startMs <= Date.now()) this.queue.push(groupId);
  }

  private async pump() {
    if (!this.active || this.pumping || this.timer) return;
    const groupId = this.queue.shift();
    if (!groupId) return;
    const state = this.groups.get(groupId);
    const cursor = state?.cursor;
    if (!state || !cursor) return;
    if (!this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId)) {
      state.done = true; void this.pump(); return;
    }
    const revision = this.revision;
    this.pumping = true; state.pending = true; state.awaitingAck = true; state.pages += 1;
    state.sentCursors.add(`${cursor.timestampMs}:${cursor.messageId}`);
    try {
      const requestId = await this.fetchHistory(PAGE_SIZE, { remoteJid: groupId, id: cursor.messageId, fromMe: Boolean(cursor.fromMe), ...(cursor.participantId ? { participant: cursor.participantId } : {}) }, cursor.timestampMs);
      if (!this.active || revision !== this.revision || this.groups.get(groupId) !== state) return;
      state.requestIds.add(requestId); state.requested = true;
      state.awaitingAck = false;
      const earlyPage = state.earlyPages.get(requestId);
      state.earlyPages.clear();
      if (earlyPage) this.acceptPage(groupId, state, earlyPage);
      writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.requested', entityType: 'whatsapp_group', entityId: groupId,
        message: 'Se solicitó al teléfono un lote de historial del grupo proveedor', details: { page: state.pages, pageSize: PAGE_SIZE } });
    } catch {
      if (!this.active || revision !== this.revision || this.groups.get(groupId) !== state) return;
      state.failed = true; state.done = true; state.pending = false;
      state.awaitingAck = false; state.earlyPages.clear();
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'supplier.history.request.failed', entityType: 'whatsapp_group', entityId: groupId,
        message: 'Falló la solicitud de historial al teléfono para este grupo proveedor' });
    } finally {
      if (this.active && revision === this.revision) {
        this.report(); this.pumping = false;
        this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, REQUEST_INTERVAL_MS);
        this.timer.unref();
      }
    }
  }

  private report() {
    if (this.startMs > Date.now()) return;
    const states = [...this.groups.values()];
    this.reception?.recordRecoveryRequests(this.sessionId, states.filter((state) => state.requested).length,
      states.filter((state) => !state.cursor).length, states.filter((state) => state.failed).length);
  }
}
