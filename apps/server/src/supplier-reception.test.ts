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
  it('stores live publications immediately outside the recovery range and deduplicates replays', async () => {
    const { db, reception, setNow } = setup();
    const message = { sessionId: 'main', groupId: 'provider@g.us', messageId: 'midnight-shoe', participantId: 'vendor@s.whatsapp.net',
      timestampMs: Date.parse('2026-10-20T05:00:00.000Z'), text: 'COD 143 TENIS PRECIO $60.000' };
    expect(await reception.capture(message)).toBe('stored');
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 1 });
    expect(reception.snapshot('main').pendingCount).toBe(0);

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

  it('processes a staged live image and description outside the recovery range in chronological order', async () => {
    const { db, reception, setNow } = setup();
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const base = { sessionId: 'main', groupId: 'provider@g.us', participantId: 'vendor@s.whatsapp.net' };
    await reception.capture({ ...base, messageId: 'photo-first', timestampMs: Date.parse('2026-10-20T05:00:01.000Z'), text: '', image: { bytes: imageBytes, mimeType: 'image/png' } }, true);
    await reception.capture({ ...base, messageId: 'description-next', timestampMs: Date.parse('2026-10-20T05:00:02.000Z'), text: 'Tenis urbanos talla 38 · PRECIO $60.000' }, true);
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

  it.each(['18:00', '19:00'])('recovers only original timestamps in the selected range ending %s, even when opened at 7 p.m.', async (endTime) => {
    const { db, directory, reception } = setup('2026-10-23T00:00:00Z');
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='16:00',reception_end_time=? WHERE session_id='main'").run(endTime);
    const base = { sessionId: 'main', groupId: 'provider@g.us', receptionMode: 'recovery' as const, text: 'COD 143 PRECIO $60.000' };
    for (const [index, time] of ['2026-10-22T15:59:59-05:00', '2026-10-21T17:00:00-05:00', `2026-10-22T${endTime}:00-05:00`].entries()) {
      expect(await reception.capture({ ...base, messageId: `excluded-${index}`, timestampMs: Date.parse(time), image: { bytes: Buffer.alloc(0), mimeType: 'image/png' } })).toBe('outside_window');
    }
    expect(db.prepare('SELECT COUNT(*) as count FROM supplier_inbox_messages').get()).toEqual({ count: 0 });
    expect(await reception.capture({ ...base, messageId: 'included', timestampMs: Date.parse('2026-10-22T16:00:00-05:00') })).toBe('stored');
    expect(await reception.capture({ ...base, messageId: 'late', timestampMs: Date.parse('2026-10-22T18:30:00-05:00') })).toBe(endTime === '19:00' ? 'stored' : 'outside_window');
    await reception.close();
    const restarted = new SupplierReceptionService(db, directory, new SupplierIngestionService(db, directory, Fastify({ logger: false }).log), Fastify({ logger: false }).log, () => Date.parse('2026-10-23T00:05:00Z'));
    expect(await restarted.capture({ ...base, messageId: 'included', timestampMs: Date.parse('2026-10-22T16:00:00-05:00') })).toBe('duplicate');
    await restarted.close(); db.close();
  });

  it('discards legacy pending history outside the range and still processes persisted live messages', async () => {
    const { db, reception } = setup('2026-10-23T00:00:00Z');
    const insert = db.prepare("INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,message_timestamp_ms,text,status,received_at,reception_mode) VALUES ('main','provider@g.us',?,?,'COD 143 PRECIO $60.000','pending',?,?)");
    const at = Date.parse('2026-10-22T15:00:00-05:00');
    insert.run('old-before-range', at, new Date(at).toISOString(), 'recovery');
    insert.run('live-before-range', at, new Date(at).toISOString(), 'live');
    await reception.scheduleChanged('main');
    expect(db.prepare('SELECT message_id,status FROM supplier_inbox_messages ORDER BY message_id').all()).toEqual([
      { message_id: 'live-before-range', status: 'processed' }, { message_id: 'old-before-range', status: 'ignored' },
    ]);
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 1 });
    await reception.close(); db.close();
  });

  it('keeps a live photo through a restart across midnight without applying the recovery filter', async () => {
    const { db, directory, reception } = setup('2026-10-23T04:50:00Z');
    const timestampMs = Date.parse('2026-10-22T23:50:00-05:00');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    await reception.capture({ groupId: 'provider@g.us', messageId: 'live-restart', timestampMs, text: 'COD 143 PRECIO $60.000', receptionMode: 'live', image: { bytes: image, mimeType: 'image/png' } }, true);
    db.prepare("UPDATE supplier_inbox_messages SET status='processing' WHERE message_id='live-restart'").run();
    await reception.close(); db.close();
    const reopened = openDatabase(join(directory, 'business.sqlite'));
    const logger = Fastify({ logger: false }).log;
    const restarted = new SupplierReceptionService(reopened, directory, new SupplierIngestionService(reopened, directory, logger), logger, () => Date.parse('2026-10-23T05:10:00Z'));
    await restarted.scheduleChanged('main');
    expect(reopened.prepare("SELECT status,reception_mode FROM supplier_inbox_messages WHERE message_id='live-restart'").get()).toEqual({ status: 'processed', reception_mode: 'live' });
    expect(reopened.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 1 });
    await restarted.close(); reopened.close();
  });
});
