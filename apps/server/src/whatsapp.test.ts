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
  fetchMessageHistory: (count: number, key: unknown, timestampMs: number) => Promise<string>;
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
    fetchMessageHistory: vi.fn(async () => 'test-history-request'),
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

  it('filters recovery by send time and accepts live messages outside the range', () => {
    const now = Date.parse('2026-10-22T19:05:00-05:00');
    const liveSince = Date.parse('2026-10-22T19:00:00-05:00');
    const range = { startTime: '16:00', endTime: '18:00', timeZone: 'America/Bogota' };
    for (const type of ['notify', 'append', 'history'] as const) {
      expect(shouldIngestSupplierMessage(type, Date.parse('2026-10-22T15:59:59-05:00'), now, range, liveSince)).toBe(false);
      expect(shouldIngestSupplierMessage(type, Date.parse('2026-10-22T17:00:00-05:00'), now, range, liveSince)).toBe(true);
      expect(shouldIngestSupplierMessage(type, Date.parse('2026-10-22T18:30:00-05:00'), now, range, liveSince)).toBe(false);
      expect(shouldIngestSupplierMessage(type, now - 30 * 24 * 60 * 60 * 1000, now, range, liveSince)).toBe(false);
      expect(shouldIngestSupplierMessage(type, now + 10 * 60 * 1000, now, range, liveSince)).toBe(false);
    }
    expect(shouldIngestSupplierMessage('notify', now, now, range, liveSince)).toBe(true);
    expect(shouldIngestSupplierMessage('append', now, now, range, liveSince)).toBe(true);
    expect(shouldIngestSupplierMessage('history', now, now, range, liveSince)).toBe(false);
  });

  it.each(['chats.upsert', 'chats.update', 'messaging-history.set'])('uses real %s message references received before supplier setup for a 7 a.m.–10 p.m. recovery at 10:52 a.m.', async (eventName) => {
    const clock = Date.parse('2026-10-24T10:52:00-05:00');
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-chat-anchors-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='07:00',reception_end_time='22:00' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const reception = new SupplierReceptionService(db, directory, new SupplierIngestionService(db, directory, logger), logger);
    const socket = fakeSocket(); mocks.makeWASocket.mockReturnValue(socket);
    const connector = new BaileysConnector(db, logger, true, new SupplierIngestionService(db, directory, logger), 'main', reception);
    await connector.connect();
    const options = mocks.makeWASocket.mock.calls.at(-1)?.[0] as { shouldSyncHistoryMessage: (notification: { syncType: number }) => boolean };
    expect(options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP })).toBe(true);
    expect(options.shouldSyncHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.FULL })).toBe(false);
    const chats = [
      { id: 'provider@g.us', messages: [{ message: { key: { remoteJid: 'provider@g.us', id: 'real-chat-reference', participant: 'vendor@s.whatsapp.net', fromMe: false }, messageTimestamp: Date.parse('2026-10-24T10:30:00-05:00') / 1000, message: { conversation: 'Este contenido no se incorpora al catálogo' } } }] },
      { id: 'timestamp-only@g.us', lastMessageRecvTimestamp: clock / 1000 },
      { id: 'wrong-group@g.us', messages: [{ message: { key: { remoteJid: 'provider@g.us', id: 'mismatched-key' }, messageTimestamp: clock / 1000 } }] },
    ];
    socket.ev.emit(eventName, eventName === 'messaging-history.set' ? { chats, messages: [], syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP } : chats);
    expect(db.prepare('SELECT group_jid,message_id FROM whatsapp_history_anchors').all()).toEqual([{ group_jid: 'provider@g.us', message_id: 'real-chat-reference' }]);
    expect(db.prepare('SELECT COUNT(*) as count FROM supplier_inbox_messages').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    expect(mocks.downloadMediaMessage).not.toHaveBeenCalled();
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
    socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(socket.fetchMessageHistory).toHaveBeenCalledWith(100,
      { remoteJid: 'provider@g.us', id: 'real-chat-reference', participant: 'vendor@s.whatsapp.net', fromMe: false }, Date.parse('2026-10-24T10:30:00-05:00')));
    expect(reception.snapshot('main')).toMatchObject({ recoveryRequestedGroups: 1, recoveryMissingAnchors: 0, recoveryMessageCount: 0 });
    await connector.disconnect(); await reception.close(); db.close();
  });

  it('reports undecryptable supplier messages safely and accepts a later decrypted delivery without duplicates', async () => {
    const clock = Date.parse('2026-10-24T10:52:00-05:00');
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-decrypt-retry-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='07:00',reception_end_time='22:00' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger, () => clock);
    const socket = fakeSocket(); mocks.makeWASocket.mockReturnValue(socket);
    const connector = new BaileysConnector(db, logger, true, ingestion, 'main', reception);
    await connector.connect();
    socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
    const key = { remoteJid: 'provider@g.us', id: 'retry-photo', participant: 'vendor@s.whatsapp.net', fromMe: false };
    const failed = { key, messageTimestamp: clock / 1000, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, messageStubParameters: ['synthetic-secret-must-not-be-logged'] };
    socket.ev.emit('messaging-history.set', { syncType: proto.HistorySync.HistorySyncType.RECENT, messages: [failed] });
    await vi.waitFor(() => expect(reception.snapshot('main').failedCount).toBe(1));
    expect(reception.snapshot('main').recoveryMessageCount).toBe(0);
    expect(connector.status().status).toBe('connected');
    expect(db.prepare('SELECT COUNT(*) as n FROM products').get()).toEqual({ n: 0 });
    expect(mocks.downloadMediaMessage).not.toHaveBeenCalled();
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [failed] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.prepare("SELECT COUNT(*) as n FROM application_logs WHERE action='supplier.message.decrypt.failed'").get()).toEqual({ n: 1 });
    expect(JSON.stringify(db.prepare('SELECT message,details_json FROM application_logs').all())).not.toContain('synthetic-secret');
    mocks.downloadMediaMessage.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const recovered = { key, messageTimestamp: clock / 1000, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'COD 143 PRECIO $60.000' } } };
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [recovered] });
    await vi.waitFor(() => expect(reception.snapshot('main').failedCount).toBe(0));
    expect(db.prepare('SELECT COUNT(*) as n FROM products').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) as n FROM application_logs WHERE action='supplier.message.decrypt.recovered'").get()).toEqual({ n: 1 });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [recovered, failed] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.prepare('SELECT COUNT(*) as n FROM products').get()).toEqual({ n: 1 });
    expect(reception.snapshot('main').failedCount).toBe(0);
    await connector.disconnect(); await reception.close(); db.close();
  });

  it('processes recent history events only from active supplier groups and rejects a full-history request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T17:00:00-05:00'));
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

  it.each(['initial', 'recent', 'on-demand', 'append', 'notify'] as const)('recovers only 4–6 p.m. photos delivered by %s at 7 p.m. and continues receiving live photos', async (kind) => {
    let clock = Date.parse('2026-10-22T19:00:00-05:00');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-recovery-range-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',10000,'🌎','bottom_right',?,?)").run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='16:00',reception_end_time='18:00' WHERE session_id='main'").run();
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
    const photo = (id: string, date: string) => ({ key: { remoteJid: 'provider@g.us', id, participant: 'vendor@s.whatsapp.net', fromMe: false }, messageTimestamp: Date.parse(date) / 1000, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'COD 143 PRECIO $60.000' } } });
    const messages = [
      photo('before-start', '2026-10-22T15:59:59-05:00'), photo('at-start', '2026-10-22T16:00:00-05:00'),
      photo('within-range', '2026-10-22T17:59:59-05:00'), photo('at-end', '2026-10-22T18:00:00-05:00'),
      photo('yesterday', '2026-10-21T17:30:00-05:00'),
    ].reverse();
    const deliver = () => kind === 'append' || kind === 'notify' ? socket.ev.emit('messages.upsert', { type: kind, messages }) : socket.ev.emit('messaging-history.set', { syncType, messages });
    deliver();
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 2 }));
    socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
    expect(reception.snapshot('main')).toMatchObject({ recoveryStatus: 'received', recoveryMessageCount: 2, pendingCount: 0 });
    expect(mocks.downloadMediaMessage).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT message_id FROM whatsapp_source_messages ORDER BY message_id').all()).toEqual([{ message_id: 'at-start' }, { message_id: 'within-range' }]);
    socket.ev.emit('messaging-history.set', { syncType: proto.HistorySync.HistorySyncType.FULL, messages: [photo('ignore-full', '2026-10-22T17:00:00-05:00')] });
    deliver();
    // A new append event at 7:05 p.m. must bypass the 4–6 p.m. recovery filter.
    clock = Date.parse('2026-10-22T19:05:00-05:00');
    socket.ev.emit('messages.upsert', { type: 'append', messages: [photo('live-append', new Date(clock).toISOString())] });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [photo('live-notify', new Date(clock).toISOString())] });
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 4 }));
    expect(reception.snapshot('main').recoveryMessageCount).toBe(2);
    expect(db.prepare("SELECT reception_mode FROM supplier_inbox_messages WHERE message_id='live-append'").get()).toEqual({ reception_mode: 'live' });
    expect(db.prepare("SELECT 1 FROM whatsapp_source_messages WHERE message_id='ignore-full'").get()).toBeUndefined();
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

  it('explicitly requests the 5–8 p.m. range when opened at 8:22 and processes the phone response without importing older photos', async () => {
    let clock = Date.parse('2026-10-22T20:22:00-05:00');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const directory = mkdtempSync(join(tmpdir(), 'tenis-2022-history-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='17:00',reception_end_time='20:00' WHERE session_id='main'").run();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('supplier','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
    db.prepare("INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms) VALUES ('main','provider@g.us','known-message',?)").run(Date.parse('2026-10-22T20:10:00-05:00'));
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const reception = new SupplierReceptionService(db, directory, new SupplierIngestionService(db, directory, logger), logger, () => clock);
    const socket = fakeSocket(); mocks.makeWASocket.mockReturnValue(socket);
    const requested = vi.fn(async () => 'phone-response'); socket.fetchMessageHistory = requested;
    mocks.downloadMediaMessage.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const connector = new BaileysConnector(db, logger, true, new SupplierIngestionService(db, directory, logger), 'main', reception);
    await connector.connect(); socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
    const photo = (id: string, time: string) => ({ key: { id, remoteJid: 'provider@g.us', fromMe: false }, messageTimestamp: Date.parse(`2026-10-22T${time}-05:00`) / 1000, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'COD 143 PRECIO $60.000' } } });
    socket.ev.emit('messaging-history.set', { syncType: proto.HistorySync.HistorySyncType.ON_DEMAND, peerDataRequestSessionId: 'phone-response', messages: [photo('before-5', '16:59:59'), photo('at-5', '17:00:00'), photo('before-8', '19:59:59'), photo('at-8', '20:00:00')] });
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 2 }));
    expect(db.prepare('SELECT message_id FROM whatsapp_source_messages ORDER BY message_id').all()).toEqual([{ message_id: 'at-5' }, { message_id: 'before-8' }]);
    expect(reception.snapshot('main')).toMatchObject({ recoveryRequestedGroups: 1, recoveryMessageCount: 2, recoveryStatus: 'received' });
    clock = Date.parse('2026-10-22T20:23:00-05:00');
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [photo('live-after-8', '20:23:00')] });
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 3 }));
    expect(mocks.downloadMediaMessage).toHaveBeenCalledTimes(3);
    await connector.disconnect(); await reception.close(); db.close();
  });

  it('receives live photos while an explicit history request is still awaiting acknowledgement', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T20:22:00-05:00'));
    const directory = mkdtempSync(join(tmpdir(), 'tenis-history-live-')); directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('supplier','main','provider@g.us','Proveedor',0,?,?)").run(now, now);
    db.prepare("INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms) VALUES ('main','provider@g.us','known-message',?)").run(Date.now() - 60_000);
    const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
    const socket = fakeSocket(); mocks.makeWASocket.mockReturnValue(socket);
    let acknowledge: (value: string) => void = () => {};
    socket.fetchMessageHistory = vi.fn(() => new Promise<string>((resolve) => { acknowledge = resolve; }));
    const connector = new BaileysConnector(db, logger, true, new SupplierIngestionService(db, directory, logger));
    await connector.connect(); socket.ev.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(socket.fetchMessageHistory).toHaveBeenCalledTimes(1));
    mocks.downloadMediaMessage.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'provider@g.us', id: 'live-photo', fromMe: false }, messageTimestamp: Date.now() / 1000, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'COD 143 PRECIO $60.000' } } }] });
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 1 }));
    await connector.disconnect(); acknowledge('late-acknowledgement'); await Promise.resolve(); db.close();
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
