import { randomUUID } from 'node:crypto';
import type { AppDatabase } from './database.js';

export type ApplicationLogLevel = 'info' | 'warning' | 'error';
export type ApplicationLogInput = {
  sessionId: string;
  level?: ApplicationLogLevel;
  category: string;
  action: string;
  entityType: string;
  entityId: string;
  message: string;
  details?: unknown;
  createdAt?: string;
};

const SENSITIVE_KEY = /(qr|token|password|secret|credential|authorization|raw.?text|caption|base64|media.?bytes|messageBody|supplierText|skippedErrors|^error$)/i;

function safeDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(safeDetails);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).slice(0, 100).map(([key, item]) => [key, safeDetails(item)]));
  }
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

/** Stores concise, append-only business events; never store message bodies or WhatsApp credentials here. */
export function writeApplicationLog(db: AppDatabase, input: ApplicationLogInput) {
  const details = safeDetails(input.details ?? {}) ?? {};
  db.prepare(`INSERT INTO application_logs(id,session_id,level,category,action,entity_type,entity_id,message,details_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), input.sessionId, input.level ?? 'info', input.category, input.action,
    input.entityType, input.entityId, input.message.slice(0, 500), JSON.stringify(details), input.createdAt ?? new Date().toISOString(),
  );
}
