import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { WAMessage } from '@whiskeysockets/baileys';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';
import { HistoryRecovery } from './history-recovery.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T20:22:00-05:00')); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'supplier-on-demand-'));
  const db = openDatabase(join(directory, 'business.sqlite'));
  const now = new Date().toISOString();
  db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='17:00',reception_end_time='20:00' WHERE session_id='main'").run();
  db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
  const logger = Fastify({ logger: false }).log;
  const reception = new SupplierReceptionService(db, directory, new SupplierIngestionService(db, directory, logger), logger);
  let nextRequest = 0;
  const fetchHistory = vi.fn(async (_count: number, _key: unknown, _timestampMs: number) => `request-${++nextRequest}`);
  const history = new HistoryRecovery(db, 'main', fetchHistory, reception);
  cleanups.push(async () => { history.stop(); await reception.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const message = (id: string, time: string, fromMe = false) => ({ key: { id, remoteJid: 'provider@g.us', fromMe, participant: 'vendor@s.whatsapp.net' }, messageTimestamp: Date.parse(`2026-10-22T${time}-05:00`) / 1000 }) as WAMessage;
  return { db, history, reception, fetchHistory, message };
}

describe('explicit supplier history requests', () => {
  it('defers a 14:50 range requested at 14:49 instead of reporting no history after 35 seconds', async () => {
    const { db, history, reception, fetchHistory, message } = setup();
    vi.setSystemTime(new Date('2026-10-22T14:49:00-05:00'));
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='14:50',reception_end_time='15:00' WHERE session_id='main'").run();
    db.prepare("DELETE FROM supplier_reception_state WHERE session_id='main'").run();
    history.observe([message('before-range', '14:48:00')]);
    history.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'idle', recoveryMissingAnchors: 0, recoveryFinishedAt: null });
    expect(reception.snapshot('main').recoveryWarning).toContain('14:50');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'waiting', recoveryMissingAnchors: 1 });
    history.observe([message('at-range-start', '14:50:00')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory.mock.calls[0]?.[1]).toMatchObject({ id: 'at-range-start' });
  });

  it('cancels the scheduled range start when the connection stops', async () => {
    const { db, history, fetchHistory } = setup();
    vi.setSystemTime(new Date('2026-10-22T14:49:00-05:00'));
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='14:50',reception_end_time='15:00' WHERE session_id='main'").run();
    history.start(); history.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('keeps real group references received before suppliers are configured without storing their message bodies', async () => {
    const { db, history, fetchHistory, message } = setup();
    db.prepare("DELETE FROM supplier_profiles WHERE id='provider'").run();
    history.observe([{ ...message('pairing-reference', '20:10:00'), message: { conversation: 'No guardar este texto' } }]);
    history.observe([{ ...message('private', '20:11:00'), key: { remoteJid: 'person@s.whatsapp.net', id: 'private' } }]);
    expect(db.prepare('SELECT group_jid,message_id FROM whatsapp_history_anchors').all()).toEqual([{ group_jid: 'provider@g.us', message_id: 'pairing-reference' }]);
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM supplier_inbox_messages').get()).toEqual({ count: 0 });
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory).not.toHaveBeenCalled();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory.mock.calls[0]?.[1]).toMatchObject({ id: 'pairing-reference', remoteJid: 'provider@g.us' });
  });

  it('at 10:52 a.m. requests all 11 supplier groups for a 7 a.m.–10 p.m. range when real recent references are available', async () => {
    const { db, history, fetchHistory, reception } = setup();
    vi.setSystemTime(new Date('2026-10-24T10:52:00-05:00'));
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='07:00',reception_end_time='22:00' WHERE session_id='main'").run();
    const now = new Date().toISOString();
    for (let index = 0; index < 11; index += 1) {
      const groupId = index === 0 ? 'provider@g.us' : `provider-${index}@g.us`;
      if (index) db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES (?,'main',?,'Proveedor',0,?,?)").run(`provider-${index}`, groupId, now, now);
      history.observe([{ key: { remoteJid: groupId, id: `real-${index}`, fromMe: true }, messageTimestamp: Date.parse('2026-10-24T10:50:00-05:00') / 1000 }]);
    }
    history.start(); await vi.advanceTimersByTimeAsync(11_000);
    expect(fetchHistory).toHaveBeenCalledTimes(11);
    expect(reception.snapshot('main')).toMatchObject({ recoveryRequestedGroups: 11, recoveryMissingAnchors: 0, recoveryMessageCount: 0 });
  });

  it('does not blame the phone for no response when no request could be made, and starts after a real reference arrives', async () => {
    const { history, reception, fetchHistory, message } = setup();
    history.start(); await vi.advanceTimersByTimeAsync(36_000);
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(reception.snapshot('main').recoveryWarning).toContain('No se pudo solicitar historial');
    expect(reception.snapshot('main').recoveryWarning).not.toContain('El teléfono no entregó');
    history.observe([message('manual-test-from-phone', '20:22:00', true)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory.mock.calls[0]?.[1]).toMatchObject({ id: 'manual-test-from-phone', fromMe: true });
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'waiting', recoveryRequestedGroups: 1, recoveryMissingAnchors: 0 });
  });

  it('at 8:22 p.m. requests pages from a known 8:10 message until reaching the 5 p.m. boundary, using milliseconds', async () => {
    const { history, reception, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00')]);
    history.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory).toHaveBeenCalledWith(50, { id: 'latest', remoteJid: 'provider@g.us', fromMe: false, participant: 'vendor@s.whatsapp.net' }, Date.parse('2026-10-22T20:10:00-05:00'));
    expect(reception.snapshot('main')).toMatchObject({ recoveryRequestedGroups: 1, recoveryMissingAnchors: 0, recoveryMessageCount: 0, recoveryStatus: 'waiting' });
    history.observe([message('page-one-newer', '19:50:00'), message('page-one-oldest', '19:30:00')], true, 'request-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(fetchHistory.mock.calls[1]?.[2]).toBe(Date.parse('2026-10-22T19:30:00-05:00'));
    history.observe([message('start', '17:00:00'), message('before-start', '16:59:59')], true, 'request-2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    // A successful request alone never claims photos were recovered.
    expect(reception.snapshot('main').recoveryMessageCount).toBe(0);
  });

  it('reports a missing anchor and requests history when the next real supplier message arrives', async () => {
    const { history, reception, fetchHistory, message } = setup();
    history.start();
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(reception.snapshot('main')).toMatchObject({ recoveryMissingAnchors: 1, recoveryRequestedGroups: 0 });
    history.observe([message('new-live-message', '20:22:00')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(reception.snapshot('main')).toMatchObject({ recoveryMissingAnchors: 0, recoveryRequestedGroups: 1 });
  });

  it('paginates a phone response that arrives before the request acknowledgement', async () => {
    const { history, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00')]);
    fetchHistory.mockImplementationOnce(async () => {
      history.observe([message('early-page', '19:30:00')], true, 'early-response');
      return 'early-response';
    });
    history.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(fetchHistory.mock.calls[1]?.[1]).toMatchObject({ id: 'early-page' });
  });

  it('does not loop on repeated pages or let an old request paginate a new attempt', async () => {
    const { history, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00')]); history.start();
    await vi.advanceTimersByTimeAsync(0);
    history.observe([message('latest', '20:10:00')], true, 'request-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    history.start(); await vi.advanceTimersByTimeAsync(0);
    history.observe([message('old-response', '18:00:00')], true, 'request-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('retains the latest anchor when receiving older pages so a retry starts from the newest known message', async () => {
    const { history, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00')]); history.start(); await vi.advanceTimersByTimeAsync(0);
    history.observe([message('older', '16:59:59')], true, 'request-1');
    await vi.advanceTimersByTimeAsync(1000);
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory.mock.calls[1]?.[1]).toMatchObject({ id: 'latest' });
  });

  it('reports request failures and allows an explicit retry without reporting success before a response', async () => {
    const { history, reception, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00')]);
    fetchHistory.mockRejectedValueOnce(new Error('Phone unavailable'));
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(reception.snapshot('main')).toMatchObject({ recoveryFailedRequests: 1, recoveryRequestedGroups: 0, recoveryMessageCount: 0 });
    await vi.advanceTimersByTimeAsync(36_000);
    expect(reception.snapshot('main').recoveryWarning).toContain('Falló la solicitud');
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(reception.snapshot('main')).toMatchObject({ recoveryFailedRequests: 0, recoveryRequestedGroups: 1, recoveryStatus: 'waiting' });
  });

  it('preserves the fromMe flag in real anchors and cancels queued requests when stopped', async () => {
    const { db, history, fetchHistory, message } = setup();
    history.observe([message('latest', '20:10:00', true)]);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('second','main','second@g.us','Segundo',0,?,?)").run(now, now);
    history.observe([{ ...message('second-latest', '20:11:00'), key: { remoteJid: 'second@g.us', id: 'second-latest', fromMe: false } }]);
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory.mock.calls[0]?.[1]).toMatchObject({ id: 'latest', fromMe: true });
    history.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it('restarts from a fresh message when a persisted cursor did not cover the end of the range', async () => {
    const { history, fetchHistory, message } = setup();
    history.observe([message('old-session-latest', '18:30:00')]); history.start(); await vi.advanceTimersByTimeAsync(0);
    history.observe([message('new-live-anchor', '20:22:00')]); await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHistory.mock.calls[1]?.[1]).toMatchObject({ id: 'new-live-anchor' });
    history.observe([message('old-response', '17:30:00')], true, 'request-1'); await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    history.observe([message('new-response', '19:50:00')], true, 'request-2'); await vi.advanceTimersByTimeAsync(1000);
    expect(fetchHistory.mock.calls[2]?.[1]).toMatchObject({ id: 'new-response' });
  });

  it('does not borrow another account anchor or request archived supplier groups', async () => {
    const { db, history, fetchHistory, reception } = setup();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Otra cuenta',?)").run(now);
    db.prepare("INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms) VALUES ('secondary','provider@g.us','other-account',?)").run(Date.now());
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at,archived_at) VALUES ('archived','main','archived@g.us','Archivado',0,?,?,?)").run(now, now, now);
    history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(reception.snapshot('main').recoveryMissingAnchors).toBe(1);
  });
});
