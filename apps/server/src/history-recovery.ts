import type { AppDatabase } from './database.js';
import type { SupplierReceptionService } from './supplier-reception.js';
import { readReceptionSchedule, recoveryEndTimestampMs, recoveryStartTimestampMs } from './reception-schedule.js';
import { writeApplicationLog } from './application-log.js';

const PAGE_SIZE = 50;
const MAX_PAGES_PER_GROUP = 20;
const REQUEST_INTERVAL_MS = 1000;
const REQUEST_ACK_TIMEOUT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 45_000;
const MAX_SILENT_ATTEMPTS = 3;
type Cursor = { groupId: string; messageId: string; timestampMs: number; fromMe: number; participantId: string | null };
export type HistoryMessageKey = { remoteJid?: string | null | undefined; id?: string | null | undefined; fromMe?: boolean | null | undefined; participant?: string | null | undefined };
export type HistoryMessage = { key: HistoryMessageKey; messageTimestamp?: unknown; message?: unknown };
type GroupRequest = {
  cursor: Cursor | undefined;
  upperBoundMs: number;
  sentCursors: Set<string>;
  acceptedCursors: Set<string>;
  earlyResponses: Map<string, Cursor[]>;
  currentRequestId: string | undefined;
  responseTimer: NodeJS.Timeout | undefined;
  pages: number;
  silentAttempts: number;
  awaitingAck: boolean;
  pending: boolean;
  done: boolean;
  requested: boolean;
  responded: boolean;
  failed: boolean;
  missingAnchor: boolean;
};
type RequestRef = { groupId: string; state: GroupRequest; cursor: Cursor; page: number; consumed: boolean };

/** Requests older messages using real group/message keys; never invent an anchor. */
export class HistoryRecovery {
  private readonly groups = new Map<string, GroupRequest>();
  private readonly requests = new Map<string, RequestRef>();
  private readonly queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  private active = false;
  private settled = false;
  private attemptStarted = false;
  private revision = 0;
  private nextRequestAt = 0;
  private startMs = 0;
  private endMs = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly sessionId: string,
    private readonly fetchHistory: (count: number, key: HistoryMessageKey, timestampMs: number, attemptId: number) => Promise<string>,
    private readonly reception?: SupplierReceptionService,
    private readonly maxInFlightResponses = Number.POSITIVE_INFINITY,
  ) {}

  start(resetStatus = true) {
    this.stop();
    this.active = true;
    this.settled = false;
    this.nextRequestAt = 0;
    const schedule = readReceptionSchedule(this.db, this.sessionId);
    this.startMs = recoveryStartTimestampMs(schedule);
    this.endMs = Math.min(Date.now(), recoveryEndTimestampMs(schedule));
    if (this.startMs > Date.now()) {
      this.reception?.beginRecovery(this.sessionId);
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, this.startMs - Date.now());
      this.timer.unref();
      return;
    }
    if (resetStatus) this.reception?.beginRecovery(this.sessionId);
    this.attemptStarted = true;
    const suppliers = this.db.prepare('SELECT source_group_id as groupId FROM supplier_profiles WHERE session_id=? AND archived_at IS NULL').all(this.sessionId) as Array<{ groupId: string }>;
    for (const { groupId } of suppliers) {
      const state = this.groupRequest(this.anchor(groupId));
      this.groups.set(groupId, state);
      if (state.missingAnchor) writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'supplier.history.missing_reference', entityType: 'whatsapp_group', entityId: groupId,
        message: 'No hay una referencia reciente para solicitar historial de este grupo proveedor' });
      this.enqueue(groupId);
    }
    this.report();
    void this.pump();
  }

  /** Stop a running attempt. A socket close records how many groups it interrupted. */
  stop(interrupted = false) {
    const wasRunning = this.active && this.attemptStarted && !this.settled;
    const interruptedGroups = interrupted && wasRunning
      ? [...this.groups.values()].filter((state) => !state.done).length
      : 0;
    this.revision += 1;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const state of this.groups.values()) if (state.responseTimer) clearTimeout(state.responseTimer);
    if (interruptedGroups) {
      for (const [groupId, state] of this.groups) if (!state.done) writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'supplier.history.interrupted', entityType: 'whatsapp_group', entityId: groupId,
        message: 'La desconexión interrumpió la solicitud de historial de este grupo proveedor', details: { requested: state.requested, responded: state.responded } });
      this.report();
      this.reception?.finishRecovery(this.sessionId, interruptedGroups);
    }
    this.groups.clear();
    this.requests.clear();
    this.queue.length = 0;
    this.pumping = false;
    this.attemptStarted = false;
  }

  observe(messages: HistoryMessage[], onDemand = false, requestId?: string | null) {
    const grouped = new Map<string, Cursor[]>();
    for (const message of messages) {
      const groupId = message.key.remoteJid;
      const timestampMs = Number(message.messageTimestamp) * 1000;
      if (typeof groupId !== 'string' || !groupId.endsWith('@g.us') || !message.key.id || !Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > Date.now() + 300_000) continue;
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

    let matchedGroup: string | undefined;
    if (onDemand && requestId) {
      const request = this.requests.get(requestId);
      if (request) {
        matchedGroup = request.groupId;
        this.acceptResponse(requestId, request, grouped.get(request.groupId) ?? []);
      } else {
        // An adapter can emit the response before its request acknowledgement resolves.
        const awaiting = [...this.groups.entries()].find(([groupId, state]) => state.awaitingAck && (!grouped.size || grouped.has(groupId)));
        if (awaiting) {
          matchedGroup = awaiting[0];
          awaiting[1].earlyResponses.set(requestId, grouped.get(awaiting[0]) ?? []);
        }
      }
    }

    for (const [groupId, batch] of grouped) {
      if (groupId === matchedGroup) continue;
      let state = this.groups.get(groupId);
      if (!state) continue;
      const latest = this.anchor(groupId);
      // A newer real message can open the upper part of the range or retry a failed request.
      if (latest && state.cursor && latest.timestampMs > state.cursor.timestampMs &&
          (state.upperBoundMs < this.endMs || state.failed || (!state.pending && state.silentAttempts > 0))) {
        if (state.responseTimer) clearTimeout(state.responseTimer);
        this.discardRequestsForState(state);
        state = this.groupRequest(latest);
        this.groups.set(groupId, state);
        this.settled = false;
        this.enqueue(groupId);
      }
      if (state.done) continue;
      if (!state.cursor) {
        state.cursor = latest;
        state.upperBoundMs = latest?.timestampMs ?? 0;
        state.missingAnchor = false;
        this.settled = false;
        if (latest) writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.reference.available', entityType: 'whatsapp_group', entityId: groupId,
          message: 'Llegó una referencia reciente para solicitar historial de este grupo proveedor', details: { messageId: latest.messageId } });
        this.enqueue(groupId);
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
    return { cursor, upperBoundMs: cursor?.timestampMs ?? 0, sentCursors: new Set(), acceptedCursors: new Set(), earlyResponses: new Map(), currentRequestId: undefined,
      responseTimer: undefined, pages: 0, silentAttempts: 0, awaitingAck: false, pending: false, done: false, requested: false,
      responded: false, failed: false, missingAnchor: !cursor };
  }

  private acceptResponse(requestId: string, request: RequestRef, batch: Cursor[]) {
    const state = request.state;
    if (request.consumed || !this.active || this.groups.get(request.groupId) !== state) return;
    const requestCursor = `${request.cursor.timestampMs}:${request.cursor.messageId}`;
    const currentCursor = state.cursor ? `${state.cursor.timestampMs}:${state.cursor.messageId}` : '';
    // A late response may satisfy a retry for the same cursor. Once that cursor
    // has advanced, ignore responses from any already-sent retry of the old page.
    if (state.acceptedCursors.has(requestCursor) || currentCursor !== requestCursor) {
      request.consumed = true;
      return;
    }
    request.consumed = true;
    const wasCurrent = state.currentRequestId === requestId;
    if (state.responseTimer) clearTimeout(state.responseTimer);
    state.responseTimer = undefined;
    // A late response supersedes a retry that is still asking for the same cursor.
    state.currentRequestId = undefined;
    state.pending = false;
    state.awaitingAck = false;
    state.done = false;
    state.failed = false;
    state.responded = true;
    state.silentAttempts = 0;
    state.pages += 1;
    state.acceptedCursors.add(requestCursor);
    this.settled = false;

    const candidates = batch.filter((item) => item.groupId === request.groupId && item.timestampMs <= request.cursor.timestampMs
      && !state.sentCursors.has(`${item.timestampMs}:${item.messageId}`));
    writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.response', entityType: 'whatsapp_group', entityId: request.groupId,
      message: candidates.length ? 'WhatsApp respondió con mensajes para el grupo proveedor' : 'WhatsApp respondió sin mensajes anteriores utilizables para el grupo proveedor',
      details: { requestId, page: request.page, messageCount: batch.length, usableMessageCount: candidates.length, late: !wasCurrent } });

    if (!candidates.length) {
      state.done = true;
    } else {
      const oldest = candidates.reduce((a, b) => a.timestampMs < b.timestampMs ? a : b);
      state.cursor = oldest;
      if (oldest.timestampMs < this.startMs) state.done = true;
      else if (state.pages >= MAX_PAGES_PER_GROUP) {
        state.done = true;
        state.failed = true;
      } else this.enqueue(request.groupId);
    }
    this.report();
  }

  private discardRequestsForState(state: GroupRequest) {
    for (const [requestId, request] of this.requests) {
      if (request.state === state) this.requests.delete(requestId);
    }
  }

  private enqueue(groupId: string) {
    const state = this.groups.get(groupId);
    if (state?.cursor && !state.pending && !state.awaitingAck && !state.done && !this.queue.includes(groupId) && this.startMs <= Date.now()) this.queue.push(groupId);
  }

  private async pump() {
    if (!this.active || this.pumping || this.timer) return;
    if (!this.queue.length) {
      this.finishIfSettled();
      return;
    }
    if ([...this.groups.values()].filter((state) => state.pending && !state.awaitingAck).length >= this.maxInFlightResponses) return;
    const waitMs = this.nextRequestAt - Date.now();
    if (waitMs > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, waitMs);
      this.timer.unref();
      return;
    }
    const groupId = this.queue.shift();
    if (!groupId) return;
    const state = this.groups.get(groupId);
    const cursor = state?.cursor;
    if (!state || !cursor || state.pending || state.awaitingAck || state.done) { void this.pump(); return; }
    if (!this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(this.sessionId, groupId)) {
      state.done = true;
      void this.pump();
      return;
    }

    const revision = this.revision;
    this.pumping = true;
    this.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    state.pending = true;
    state.awaitingAck = true;
    state.sentCursors.add(`${cursor.timestampMs}:${cursor.messageId}`);
    let acknowledgementTimer: NodeJS.Timeout | undefined;
    let acknowledgementTimedOut = false;
    try {
      const requestId = await Promise.race([
        this.fetchHistory(PAGE_SIZE,
          { remoteJid: groupId, id: cursor.messageId, fromMe: Boolean(cursor.fromMe), ...(cursor.participantId ? { participant: cursor.participantId } : {}) },
          cursor.timestampMs, revision),
        new Promise<string>((_resolve, reject) => {
          acknowledgementTimer = setTimeout(() => { acknowledgementTimedOut = true; reject(new Error('history_request_ack_timeout')); }, REQUEST_ACK_TIMEOUT_MS);
          acknowledgementTimer.unref();
        }),
      ]);
      if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
      if (!this.active || revision !== this.revision || this.groups.get(groupId) !== state) return;
      state.requested = true;
      state.awaitingAck = false;
      state.currentRequestId = requestId;
      this.requests.set(requestId, { groupId, state, cursor, page: state.pages + 1, consumed: false });
      writeApplicationLog(this.db, { sessionId: this.sessionId, category: 'connection', action: 'supplier.history.requested', entityType: 'whatsapp_group', entityId: groupId,
        message: 'Se solicitó al teléfono un lote de historial del grupo proveedor', details: { requestId, page: state.pages, pageSize: PAGE_SIZE } });
      const early = state.earlyResponses.get(requestId);
      state.earlyResponses.clear();
      if (early) {
        this.acceptResponse(requestId, this.requests.get(requestId)!, early);
      } else {
        state.responseTimer = setTimeout(() => {
          state.responseTimer = undefined;
          if (!this.active || revision !== this.revision || this.groups.get(groupId) !== state || !state.pending || state.currentRequestId !== requestId) return;
          state.pending = false;
          state.currentRequestId = undefined;
          state.silentAttempts += 1;
          if (state.silentAttempts < MAX_SILENT_ATTEMPTS) {
            this.enqueue(groupId);
          } else {
            state.done = true;
            state.failed = true;
            writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: 'supplier.history.no.response', entityType: 'whatsapp_group', entityId: groupId,
              message: 'No se observó una respuesta de historial para este grupo proveedor', details: { attempts: state.silentAttempts } });
          }
          this.report();
          void this.pump();
        }, RESPONSE_TIMEOUT_MS);
        state.responseTimer.unref();
      }
    } catch {
      if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
      if (!this.active || revision !== this.revision || this.groups.get(groupId) !== state) return;
      state.pending = false;
      state.awaitingAck = false;
      state.currentRequestId = undefined;
      state.earlyResponses.clear();
      state.silentAttempts += 1;
      const exhausted = state.silentAttempts >= MAX_SILENT_ATTEMPTS;
      state.failed = exhausted;
      state.done = exhausted;
      writeApplicationLog(this.db, { sessionId: this.sessionId, level: 'warning', category: 'connection', action: exhausted ? 'supplier.history.request.failed' : 'supplier.history.request.retry', entityType: 'whatsapp_group', entityId: groupId,
        message: exhausted
          ? acknowledgementTimedOut ? 'La solicitud de historial agotó el tiempo de espera y terminó sus reintentos' : 'La solicitud de historial falló y terminó sus reintentos'
          : acknowledgementTimedOut ? 'La solicitud de historial no recibió confirmación a tiempo; se volverá a intentar' : 'Falló el envío de la solicitud de historial; se volverá a intentar',
        details: { stage: acknowledgementTimedOut ? 'send_ack_timeout' : 'send_failed', attempts: state.silentAttempts } });
      if (!exhausted) this.enqueue(groupId);
    } finally {
      if (this.active && revision === this.revision) {
        this.report();
        this.pumping = false;
        if (this.queue.length) void this.pump();
        else this.finishIfSettled();
      }
    }
  }

  private report() {
    if (this.startMs > Date.now()) return;
    const states = [...this.groups.values()];
    const queued = new Set(this.queue);
    this.reception?.recordRecoveryRequests(this.sessionId, states.filter((state) => state.requested).length,
      states.filter((state) => state.missingAnchor).length, states.filter((state) => state.failed).length,
      states.filter((state) => state.pending || state.awaitingAck || queued.has(state.cursor?.groupId ?? '')).length,
      states.filter((state) => state.responded).length);
  }

  private finishIfSettled() {
    if (!this.active || !this.attemptStarted || this.settled || this.pumping || this.timer || this.queue.length) return;
    // A group without a usable anchor remains open for the next real group message.
    const remaining = [...this.groups.values()].some((state) => state.pending || state.awaitingAck || (state.cursor && !state.done));
    if (remaining) return;
    this.report();
    this.settled = true;
    this.reception?.finishRecovery(this.sessionId);
  }
}
