import { DEFAULT_RECOVERY_SCHEDULE, isInRecoveryWindow, type ReceptionSchedule } from './reception-schedule.js';

export type WhatsAppStatus = 'disabled' | 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out';
export type WhatsAppGroup = { id: string; name: string };
export type WhatsAppReceptionResult = 'processing' | 'stored' | 'duplicate' | 'pending' | 'older_message_skipped' | 'outside_recovery_window' | 'unsupported_message' | 'error';
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

export interface WhatsAppConnector {
  status(): { status: WhatsAppStatus; qr: string | null; lastError: string | null; reconnectScheduled?: boolean; reception?: WhatsAppReceptionDiagnostics };
  connect(): Promise<void>;
  regenerateQr?(): Promise<void>;
  disconnect(): Promise<void>;
  resetSession(): Promise<void>;
  listGroups(): Promise<WhatsAppGroup[]>;
  requestHistory?(): Promise<void>;
  syncSupplierGroups?(): Promise<void>;
  sendImage(groupId: string, bytes: Buffer, mimeType: string, caption?: string): Promise<{ messageId: string }>;
}

const MAX_APPENDED_SUPPLIER_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;

function isLiveMessage(upsertType: 'notify' | 'append' | 'history', timestampMs: number, liveSinceMs: number): boolean {
  return upsertType !== 'history' && timestampMs >= liveSinceMs;
}

/** Old notify/append events are recovery too; only new messages bypass the time range. */
export function shouldIngestSupplierMessage(upsertType: 'notify' | 'append' | 'history', messageTimestampMs: number, nowMs = Date.now(), schedule: ReceptionSchedule = DEFAULT_RECOVERY_SCHEDULE, liveSinceMs = nowMs): boolean {
  const valid = Number.isFinite(messageTimestampMs)
    && messageTimestampMs <= nowMs + 5 * 60 * 1000
    && nowMs - messageTimestampMs <= MAX_APPENDED_SUPPLIER_MESSAGE_AGE_MS;
  return valid && (isLiveMessage(upsertType, messageTimestampMs, liveSinceMs) || isInRecoveryWindow(messageTimestampMs, schedule, nowMs));
}
