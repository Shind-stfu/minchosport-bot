import type { AppDatabase } from './database.js';

/** A reactivation starts a new receive window, so paused history cannot return later. */
export function acceptsSupplierMessage(db: AppDatabase, sessionId: string, groupId: string, timestampMs: number) {
  const supplier = db.prepare(`SELECT reception_enabled as enabled,reception_resumed_at_ms as resumedAt
    FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL`)
    .get(sessionId, groupId) as { enabled: number; resumedAt: number | null } | undefined;
  return Boolean(supplier?.enabled && (supplier.resumedAt === null
    || Number.isFinite(timestampMs) && timestampMs >= supplier.resumedAt));
}
