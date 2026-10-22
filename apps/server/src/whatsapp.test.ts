import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DisconnectReason, proto } from '@whiskeysockets/baileys';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDatabase } from './database.js';
import { openDatabase } from './database.js';

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  saveCreds: vi.fn(),
  downloadMediaMessage: vi.fn(),
  authState: { creds: {} as Record<string, unknown>, keys: {} },
  timeline: [] as string[],
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, default: mocks.makeWASocket, downloadMediaMessage: mocks.downloadMediaMessage };
});

vi.mock('./encrypted-auth.js', () => ({
  currentUserProtector: vi.fn(),
  EncryptedWhatsAppAuth: {
    create: async () => ({ state: async () => ({ state: mocks.authState, saveCreds: mocks.saveCreds }) }),
  },
}));

import { BaileysConnector, BaileysSessionRegistry, shouldIngestSupplierMessage } from './whatsapp.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';

const directories: string[] = [];

type FakeSocket = {
  ev: { on: (event: string, handler: (payload: any) => void) => void; emit: (event: string, payload: any) => void };
  end: () => void;
  groupFetchAllParticipating: () => Promise<Record<string, never>>;
};

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, Array<(payload: any) => void>>();
  return {
    ev: {
      on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      emit: (event, payload) => { for (const handler of handlers.get(event) ?? []) handler(payload); },
    },
    end: vi.fn(),
    groupFetchAllParticipating: async () => ({}),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Baileys QR pairing lifecycle', () => {
  it('persists pairing credentials before reconnecting after restartRequired (515)', async () => {
    mocks.timeline.length = 0;
    mocks.authState.creds = {};
    mocks.saveCreds.mockImplementation(async () => { mocks.timeline.push('save-creds'); });
    const sockets: FakeSocket[] = [];
    mocks.makeWASocket.mockImplementation(() => {
      mocks.timeline.push(`socket-${sockets.length + 1}`);
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    });
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const connector = new BaileysConnector({} as AppDatabase, logger, true);

    await connector.connect();
    sockets[0]!.ev.emit('creds.update', {});
    const error = Object.assign(new Error('Stream Errored (restart required)'), { output: { statusCode: DisconnectReason.restartRequired } });
    sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });

    for (let attempt = 0; attempt < 20 && sockets.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(2);
    expect(mocks.timeline.indexOf('save-creds')).toBeLessThan(mocks.timeline.indexOf('socket-2'));
    expect(connector.status().status).toBe('connecting');

    sockets[1]!.ev.emit('connection.update', { connection: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connector.status().status).toBe('connected');
    await connector.disconnect();
  });

  it('resets only the selected account credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-session-reset-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Secundaria',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('secondary','[]',?)").run(now);
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('secondary','stopped',?)").run(now);
    db.prepare("INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES ('main','creds','main','main-secret'),('secondary','creds','main','secondary-secret')").run();
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const secondary = new BaileysConnector(db, logger, true, undefined, 'secondary');
    await secondary.resetSession();
    expect(db.prepare('SELECT session_id,ciphertext FROM whatsapp_auth_records').all()).toEqual([{ session_id: 'main', ciphertext: 'main-secret' }]);
    db.close();
  });

  it('reconnects only accounts with previously saved credentials at startup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-auto-reconnect-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('unpaired','Sin vincular',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('unpaired','[]',?)").run(now);
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('unpaired','stopped',?)").run(now);
    db.prepare("INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES ('main','creds','main','saved-secret')").run();
    const sockets: FakeSocket[] = [];
    mocks.makeWASocket.mockImplementation(() => { const socket = fakeSocket(); sockets.push(socket); return socket; });
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const registry = new BaileysSessionRegistry(db, logger, true, new SupplierIngestionService(db, directory, logger));
    await registry.connectSavedSessions();
    expect(sockets).toHaveLength(1);
    expect(registry.get('main')?.status().status).toBe('connecting');
    expect(registry.get('unpaired')?.status().status).toBe('disconnected');
    await registry.close();
    db.close();
  });

  it('accepts recent messages and applies the same 24-hour bound to live and recovered events', () => {
    const now = Date.now();
    expect(shouldIngestSupplierMessage('notify', now - 30 * 24 * 60 * 60 * 1000, now)).toBe(false);
    expect(shouldIngestSupplierMessage('append', now - 5 * 60 * 1000, now)).toBe(true);
    expect(shouldIngestSupplierMessage('history', now - 5 * 60 * 1000, now)).toBe(true);
    expect(shouldIngestSupplierMessage('append', now - 24 * 60 * 60 * 1000 - 1, now)).toBe(false);
    expect(shouldIngestSupplierMessage('append', now + 10 * 60 * 1000, now)).toBe(false);
  });

  it('processes recent history events only from active supplier groups and rejects a full-history request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-history-sync-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-history','main','provider@g.us','Proveedor',10000,'🌎','bottom_right',?,?)`).run(now, now);
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger);
    const socket = fakeSocket();
    mocks.makeWASocket.mockReturnValue(socket);
    const connector = new BaileysConnector(db, logger, true, ingestion, 'main', reception);
    await connector.connect();
    const socketOptions = mocks.makeWASocket.mock.calls.at(-1)?.[0] as { shouldSyncHistoryMessage: (notification: { syncType: number }) => boolean };
    expect(socketOptions.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.RECENT })).toBe(true);
    expect(socketOptions.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP })).toBe(true);
    expect(socketOptions.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.ON_DEMAND })).toBe(true);
    expect(socketOptions.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.FULL })).toBe(false);
    socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(db.prepare("SELECT recovery_status FROM supplier_reception_state WHERE session_id='main'").get()).toEqual({ recovery_status: 'waiting' }));
    const nowMs = Date.now();
    socket.ev.emit('messaging-history.set', { syncType: proto.HistorySync.HistorySyncType.RECENT, messages: [
      { key: { remoteJid: 'other@g.us', id: 'other-message', fromMe: false }, messageTimestamp: Math.floor(nowMs / 1000), message: { conversation: 'No procesar' } },
      { key: { remoteJid: 'provider@g.us', id: 'old-message', fromMe: false }, messageTimestamp: Math.floor((nowMs - 25 * 60 * 60 * 1000) / 1000), message: { conversation: 'Fuera de ventana' } },
      { key: { remoteJid: 'provider@g.us', id: 'recovered-message', participant: 'vendor@s.whatsapp.net', fromMe: false }, messageTimestamp: Math.floor(nowMs / 1000), message: { conversation: 'COD 143 PRECIO $60.000' } },
    ] } as any);
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM supplier_inbox_messages').get()).toEqual({ count: 1 }));
    expect(db.prepare('SELECT group_jid,message_id,status FROM supplier_inbox_messages').get()).toMatchObject({ group_jid: 'provider@g.us', message_id: 'recovered-message' });
    expect(db.prepare("SELECT recovery_message_count FROM supplier_reception_state WHERE session_id='main'").get()).toEqual({ recovery_message_count: 1 });
    await connector.disconnect();
    await reception.close();
    db.close();
  });

  it.each(['initial', 'recent', 'on-demand', 'append'] as const)('buffers three 11:09 photos delivered by %s at 11:10 and shows all three at 11:12', async (kind) => {
    let clock = Date.parse('2026-10-21T16:10:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-1109-recovery-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',10000,'🌎','bottom_right',?,?)").run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='11:12',reception_end_time='21:00' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger, () => clock);
    mocks.downloadMediaMessage.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const socket = fakeSocket(); mocks.makeWASocket.mockReturnValue(socket);
    const connector = new BaileysConnector(db, logger, true, ingestion, 'main', reception);
    await connector.connect();
    const syncType = kind === 'initial' ? proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP : kind === 'on-demand' ? proto.HistorySync.HistorySyncType.ON_DEMAND : proto.HistorySync.HistorySyncType.RECENT;
    const options = mocks.makeWASocket.mock.calls.at(-1)?.[0];
    expect(options.syncFullHistory).toBe(false);
    expect(options.shouldSyncHistoryMessage({ syncType })).toBe(true);
    const messages = [3, 2, 1].map((index) => ({ key: { remoteJid: 'provider@g.us', id: `photo-1109-${index}`, participant: 'vendor@s.whatsapp.net', fromMe: false }, messageTimestamp: Date.parse(`2026-10-21T16:09:0${index}.000Z`) / 1000, message: { imageMessage: { mimetype: 'image/jpeg', caption: `COD ${index} PRECIO $60.000` } } }));
    const deliver = () => kind === 'append' ? socket.ev.emit('messages.upsert', { type: 'append', messages }) : socket.ev.emit('messaging-history.set', { syncType, messages });
    // The history queue may run before the connection-open handler.
    deliver();
    await vi.waitFor(() => expect(reception.snapshot('main').pendingCount).toBe(3));
    socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'received', recoveryMessageCount: 3, pendingCount: 3 });
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    // A full-history event is still ignored, even if emitted directly.
    socket.ev.emit('messaging-history.set', { syncType: proto.HistorySync.HistorySyncType.FULL, messages: [{ ...messages[0], key: { ...messages[0]!.key, id: 'must-ignore-full' } }] });
    clock = Date.parse('2026-10-21T16:12:00.000Z');
    await reception.scheduleChanged('main');
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 3 });
    expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 3 });
    expect(reception.snapshot('main').pendingCount).toBe(0);
    deliver();
    await vi.waitFor(() => expect(connector.status().reception?.lastSupplierResult).toBe('duplicate'));
    expect(reception.snapshot('main').recoveryMessageCount).toBe(3);
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 3 });
    await connector.disconnect(); await reception.close(); db.close();
  });

  it('shares group lookups and pauses them after a rate limit without blocking message reception', async () => {
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-group-rate-limit-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const socket = fakeSocket();
    const fetch = vi.fn().mockRejectedValueOnce(new Error('rate-overlimit')).mockResolvedValue({});
    socket.groupFetchAllParticipating = fetch;
    mocks.makeWASocket.mockReturnValue(socket);
    const connector = new BaileysConnector(db, logger, true);
    await connector.connect(); socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(connector.status().lastError).toBe('rate-overlimit'));
    for (let index = 0; index < 10; index += 1) { socket.ev.emit('groups.update', []); socket.ev.emit('group-participants.update', {}); }
    await Promise.all([connector.listGroups(), connector.listGroups()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 120_001;
    await Promise.all([connector.listGroups(), connector.listGroups()]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(connector.status()).toMatchObject({ status: 'connected', lastError: null });
    await connector.disconnect(); db.close();
  });

  it('stores a supplier photo delivered as a recent appended Baileys message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-appended-message-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    const supplierGroupId = 'supplier@g.us';
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-test','main',?,'Bodega de prueba',10000,'🌎⭐','bottom_right',?,?)`).run(supplierGroupId,now,now);
    const photo = Buffer.from([0xff,0xd8,0xff,0x00]);
    mocks.downloadMediaMessage.mockResolvedValue(photo);
    const socket = fakeSocket();
    mocks.makeWASocket.mockReturnValue(socket);
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const connector = new BaileysConnector(db, logger, true, ingestion);
    await connector.connect();
    socket.ev.emit('connection.update', { connection: 'open' });
    socket.ev.emit('messages.upsert', {
      type: 'append',
      messages: [{
        key: { remoteJid: supplierGroupId, id: 'photo-appended', participant: 'vendor@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { imageMessage: { mimetype: 'image/jpeg', caption: 'COD 960 NIKE METCON HOMBRE 💲70.000' } },
      }],
    });

    await vi.waitFor(() => {
      expect(db.prepare('SELECT COUNT(*) as count FROM products WHERE supplier_id=\'supplier-test\'').get()).toEqual({ count: 1 });
    });
    expect(db.prepare('SELECT raw_text,shoe_code,margin_cop_applied FROM products WHERE supplier_id=\'supplier-test\'').get()).toEqual({
      raw_text: 'COD 960 NIKE METCON HOMBRE 💲70.000', shoe_code: '960', margin_cop_applied: 10000,
    });
    expect(db.prepare('SELECT mime_type FROM media_assets WHERE product_id=(SELECT id FROM products WHERE supplier_id=\'supplier-test\')').get()).toEqual({ mime_type: 'image/jpeg' });
    expect(connector.status().reception).toMatchObject({
      lastUpsertType: 'append', lastSupplierName: 'Bodega de prueba', lastSupplierResult: 'stored',
    });
    await connector.disconnect();
    db.close();
  });

  it('stores an image shared as a document with a caption, including WhatsApp caption wrappers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-document-photo-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    const supplierGroupId = 'supplier@g.us';
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-doc-test','main',?,'Bodega de prueba',10000,'🌎⭐','bottom_right',?,?)`).run(supplierGroupId, now, now);
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    mocks.downloadMediaMessage.mockResolvedValue(photo);
    const socket = fakeSocket();
    mocks.makeWASocket.mockReturnValue(socket);
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const connector = new BaileysConnector(db, logger, true, ingestion);
    await connector.connect();
    socket.ev.emit('connection.update', { connection: 'open' });
    socket.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: supplierGroupId, id: 'document-photo', participant: 'vendor@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                mimetype: 'application/octet-stream',
                fileName: 'COD-143.jpg',
                caption: 'COD 143 NIKE HOMBRE 💲70.000',
              },
            },
          },
        },
      }],
    });

    await vi.waitFor(() => {
      expect(db.prepare('SELECT COUNT(*) as count FROM products WHERE supplier_id=\'supplier-doc-test\'').get()).toEqual({ count: 1 });
    });
    expect(db.prepare('SELECT raw_text FROM products WHERE supplier_id=\'supplier-doc-test\'').get()).toEqual({ raw_text: 'COD 143 NIKE HOMBRE 💲70.000' });
    expect(db.prepare('SELECT mime_type FROM media_assets WHERE product_id=(SELECT id FROM products WHERE supplier_id=\'supplier-doc-test\')').get()).toEqual({ mime_type: 'image/jpeg' });
    expect(connector.status().reception).toMatchObject({ lastSupplierResult: 'stored' });
    await connector.disconnect();
    db.close();
  });
});
