import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(initialTime = '2026-10-20T07:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-supplier-reception-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'business.sqlite'));
  const now = new Date(initialTime).toISOString();
  db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,box_margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('provider-main','main','provider@g.us','Proveedor',10000,5000,'🌎','bottom_right',?,?)").run(now, now);
  let nowMs = Date.parse(initialTime);
  const logger = Fastify({ logger: false }).log;
  const ingestion = new SupplierIngestionService(db, directory, logger);
  const reception = new SupplierReceptionService(db, directory, ingestion, logger, () => nowMs);
  return { directory, db, reception, setNow: (value: string) => { nowMs = Date.parse(value); } };
}

describe('durable supplier reception queue', () => {
  it('updates recovery when history arrives after the timeout and preserves a received status on empty batches', async () => {
    vi.useFakeTimers();
    const { db, reception, setNow } = setup('2026-10-21T16:10:00.000Z');
    reception.beginRecovery('main');
    expect(reception.snapshot('main').recoveryStatus).toBe('waiting');
    setNow('2026-10-21T16:10:36.000Z');
    await vi.advanceTimersByTimeAsync(36_000);
    expect(reception.snapshot('main').recoveryStatus).toBe('unavailable');
    await reception.recordHistoryBatch('main', 3);
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'received', recoveryMessageCount: 3 });
    await reception.recordHistoryBatch('main', 0);
    await vi.advanceTimersByTimeAsync(36_000);
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'received', recoveryMessageCount: 3 });
    await reception.close(); db.close();
  });
  it('holds after-hours publications until the configured window opens, then keeps the product after restart and deduplicates replays', async () => {
    const { db, reception, setNow } = setup();
    const message = { sessionId: 'main', groupId: 'provider@g.us', messageId: 'midnight-shoe', participantId: 'vendor@s.whatsapp.net',
      timestampMs: Date.parse('2026-10-20T05:00:00.000Z'), text: 'COD 143 TENIS PRECIO $60.000' };
    expect(await reception.capture(message)).toBe('pending');
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    expect(reception.snapshot('main').pendingCount).toBe(1);

    setNow('2026-10-20T14:00:00.000Z');
    await reception.scheduleChanged('main');
    expect(db.prepare('SELECT title,raw_text FROM products').get()).toMatchObject({ raw_text: message.text });
    expect(reception.snapshot('main').pendingCount).toBe(0);
    expect(db.prepare('SELECT status FROM supplier_inbox_messages WHERE message_id=?').get(message.messageId)).toEqual({ status: 'processed' });

    db.prepare('DELETE FROM products').run();
    expect(await reception.capture(message)).toBe('duplicate');
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM whatsapp_source_messages WHERE message_id=?').get(message.messageId)).toEqual({ count: 1 });
    db.close();
  });

  it('replays staged image and description in chronological order after midnight capture', async () => {
    const { db, reception, setNow } = setup();
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const base = { sessionId: 'main', groupId: 'provider@g.us', participantId: 'vendor@s.whatsapp.net' };
    await reception.capture({ ...base, messageId: 'photo-first', timestampMs: Date.parse('2026-10-20T05:00:01.000Z'), text: '', image: { bytes: imageBytes, mimeType: 'image/png' } });
    await reception.capture({ ...base, messageId: 'description-next', timestampMs: Date.parse('2026-10-20T05:00:02.000Z'), text: 'Tenis urbanos talla 38 · PRECIO $60.000' });
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });

    setNow('2026-10-20T14:00:00.000Z');
    await reception.scheduleChanged('main');
    expect(db.prepare('SELECT raw_text FROM products').get()).toEqual({ raw_text: 'Tenis urbanos talla 38 · PRECIO $60.000' });
    expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) as count FROM supplier_inbox_messages WHERE status='processed'").get()).toEqual({ count: 2 });
    db.close();
  });

  it('surfaces failed downloads and discards pending messages from an archived provider', async () => {
    const { db, reception } = setup();
    reception.recordUnsupported('main', 'provider@g.us', 'failed-photo', Date.now(), 'No se pudo descargar el archivo');
    expect(reception.snapshot('main').failedCount).toBe(1);
    reception.archiveProvider('main', 'provider@g.us');
    expect(db.prepare('SELECT status FROM supplier_inbox_messages WHERE message_id=?').get('failed-photo')).toEqual({ status: 'ignored' });
    db.close();
  });
});
