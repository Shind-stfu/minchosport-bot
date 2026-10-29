import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';
import { WhatsmeowConnector, type WhatsmeowSidecarEvent } from './whatsmeow-connector.js';

describe('WhatsmeowConnector', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('connects through the bridge, refreshes groups and sends an explicitly selected image', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-connector-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    const targetGroupId = 'buyers@g.us';
    db.prepare("UPDATE whatsapp_session_settings SET target_group_ids=?,updated_at=? WHERE session_id='main'")
      .run(JSON.stringify([targetGroupId]), now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='00:00',reception_end_time='23:59' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' });
    const ingestion = new SupplierIngestionService(db, directory, logger);

    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    let initialSupplierGroupIds: string[] = [];
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const child = { exitCode: null as number | null, killed: false };
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: false }),
      command: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
        calls.push({ type, payload });
        if (type === 'connect') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'qr', qr: 'temporary-qr' }));
        if (type === 'groups') return { type: 'response' as const, ok: true, groups: [{ id: targetGroupId, name: 'Compradores' }] };
        if (type === 'history') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'history-batch', batch: {
          onDemand: true, requestId: String(payload.requestId), groupIds: [], messages: [],
        } }));
        if (type === 'send-image') return { type: 'response' as const, ok: true, messageId: 'outbound-message-id' };
        return { type: 'response' as const, ok: true };
      }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, ingestion, 'main', undefined, {
      protector,
      bridgeFactory: (_binary, _databasePath, key, onEvent, _onExit, supplierGroupIds) => {
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        initialSupplierGroupIds = supplierGroupIds;
        emitEvent = onEvent;
        return bridge;
      },
    });

    try {
      await connector.connect();
      expect(initialSupplierGroupIds).toEqual([]);
      await vi.waitFor(() => expect(connector.status().status).toBe('qr'));
      expect(connector.status().qr).toBe('temporary-qr');

      emitEvent?.({ type: 'event', event: 'connected' });
      await vi.waitFor(() => expect(db.prepare('SELECT subject FROM whatsapp_groups WHERE session_id=? AND jid=?').get('main', targetGroupId)).toEqual({ subject: 'Compradores' }));
      expect(await connector.listGroups()).toEqual([{ id: targetGroupId, name: 'Compradores' }]);
      emitEvent?.({ type: 'event', event: 'message', message: {
        type: 'notify', groupId: 'other-group@g.us', messageId: 'live-message', timestampMs: Date.now(), fromMe: false, text: 'live message',
      } });
      await vi.waitFor(() => expect(connector.status().reception).toMatchObject({ lastUpsertType: 'notify', lastUpsertMessageCount: 1 }));

      const image = Buffer.from('test-image-bytes');
      await expect(connector.sendImage(targetGroupId, image, 'image/jpeg', 'caption')).resolves.toEqual({ messageId: 'outbound-message-id' });
      expect(calls.find((call) => call.type === 'send-image')?.payload).toMatchObject({
        groupId: targetGroupId,
        imageBase64: image.toString('base64'),
        mimeType: 'image/jpeg',
        caption: 'caption',
      });
      await expect(connector.sendImage('not-selected@g.us', image, 'image/jpeg')).rejects.toThrow('El grupo no está habilitado como destino de publicación.');
      expect(calls.filter((call) => call.type === 'groups')).toHaveLength(1);

      db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)")
        .run(now, now);
      await connector.syncSupplierGroups();
      expect(calls.filter((call) => call.type === 'supplier-groups').at(-1)?.payload).toEqual({ supplierGroupIds: ['provider@g.us'] });
      const anchorMs = Date.now() - 60_000;
      db.prepare(`INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms,from_me,participant_jid)
        VALUES ('main','provider@g.us','history-anchor',?,0,'vendor@s.whatsapp.net')`).run(anchorMs);
      await connector.requestHistory();
      await vi.waitFor(() => expect(calls.some((call) => call.type === 'history')).toBe(true));
      const historyCall = calls.find((call) => call.type === 'history')!;
      expect(historyCall.payload).toMatchObject({
        groupId: 'provider@g.us',
        messageId: 'history-anchor',
        timestampSec: Math.floor(anchorMs / 1000),
        fromMe: false,
      });
      await vi.waitFor(() => expect(db.prepare("SELECT entity_id FROM application_logs WHERE action='supplier.history.response'").get()).toEqual({ entity_id: 'provider@g.us' }));
      const emptyResponse = db.prepare("SELECT details_json FROM application_logs WHERE action='supplier.history.response'").get() as { details_json: string };
      expect(JSON.parse(emptyResponse.details_json)).toMatchObject({ requestId: historyCall.payload.requestId, messageCount: 0, usableMessageCount: 0 });

      await connector.disconnect();
      emitEvent?.({ type: 'event', event: 'disconnected' });
      expect(connector.status()).toMatchObject({ status: 'disconnected', lastError: null });
    } finally {
      await connector.close();
      db.close();
    }
  });

  it('restores a paired native store if the app crashed before writing its paired marker', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-paired-recovery-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const storeDirectory = join(directory, 'whatsmeow');
    mkdirSync(storeDirectory, { recursive: true });
    writeFileSync(join(storeDirectory, 'main.sqlite'), 'native store with pairing');
    const logger = pino({ level: 'silent' });
    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    const child = { exitCode: null as number | null, killed: false };
    const calls: string[] = [];
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: true }),
      command: vi.fn(async (type: string) => {
        calls.push(type);
        if (type === 'connect') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'connected' }));
        return type === 'groups'
          ? { type: 'response' as const, ok: true, groups: [] }
          : { type: 'response' as const, ok: true };
      }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, undefined, 'main', undefined, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, onEvent) => {
        emitEvent = onEvent;
        return bridge;
      },
    });

    try {
      await expect(connector.connectSavedSession()).resolves.toBe(true);
      await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
      expect(calls).toContain('connect');
      expect(db.prepare("SELECT 1 FROM whatsapp_auth_records WHERE session_id='main' AND record_type='whatsmeow-state' AND record_id='paired'").get()).toBeTruthy();
    } finally {
      await connector.close();
      db.close();
    }
  });

  it('does not open a QR on startup for a native store that was never paired', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-unpaired-probe-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const storeDirectory = join(directory, 'whatsmeow');
    mkdirSync(storeDirectory, { recursive: true });
    writeFileSync(join(storeDirectory, 'main.sqlite'), 'native store without pairing');
    const logger = pino({ level: 'silent' });
    const child = { exitCode: null as number | null, killed: false };
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: false }),
      command: vi.fn(async () => ({ type: 'response' as const, ok: true })),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, undefined, 'main', undefined, {
      protector,
      bridgeFactory: () => bridge,
    });

    try {
      await expect(connector.connectSavedSession()).resolves.toBe(false);
      expect(bridge.command).not.toHaveBeenCalledWith('connect');
      expect(bridge.shutdown).toHaveBeenCalledOnce();
      expect(connector.status().status).toBe('disconnected');
      expect(db.prepare("SELECT 1 FROM whatsapp_auth_records WHERE session_id='main' AND record_type='whatsmeow-state' AND record_id='paired'").get()).toBeUndefined();
    } finally {
      await connector.close();
      db.close();
    }
  });

  it('counts only in-range incoming history from active supplier groups', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const clock = Date.parse('2026-10-28T10:00:00-05:00');
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-history-count-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)")
      .run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='07:00',reception_end_time='22:00' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' });
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger);
    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    const child = { exitCode: null as number | null, killed: false };
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: false }),
      command: vi.fn(async (type: string) => {
        if (type === 'connect') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'connected' }));
        if (type === 'groups') return { type: 'response' as const, ok: true, groups: [] };
        return { type: 'response' as const, ok: true };
      }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, ingestion, 'main', reception, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, onEvent) => {
        emitEvent = onEvent;
        return bridge;
      },
    });

    try {
      await connector.connect();
      await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
      await vi.waitFor(() => expect(reception.snapshot('main').recoveryStartedAt).not.toBeNull());
      const timestampMs = clock - 30_000;
      const historyMessage = (groupId: string, messageId: string, fromMe = false) => ({
        type: 'history' as const, groupId, messageId, timestampMs, fromMe, text: '',
      });
      emitEvent?.({ type: 'event', event: 'message', message: historyMessage('provider@g.us', 'provider-history') });
      emitEvent?.({ type: 'event', event: 'message', message: historyMessage('unrelated@g.us', 'unrelated-history') });
      emitEvent?.({ type: 'event', event: 'message', message: historyMessage('provider@g.us', 'own-history', true) });

      await vi.waitFor(() => expect(reception.snapshot('main').recoveryMessageCount).toBe(1));
      expect(reception.snapshot('main')).toMatchObject({ recoveryMessageCount: 1, recoverySavedCount: 0 });
      expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 0 });
    } finally {
      await connector.close();
      await reception.close();
      db.close();
    }
  });

  it('keeps an undecryptable supplier publication pending, then stores a later retry once', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const clock = Date.parse('2026-10-28T10:00:00-05:00');
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-decrypt-retry-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date(clock).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)")
      .run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='07:00',reception_end_time='22:00' WHERE session_id='main'").run();
    const logger = pino({ level: 'silent' });
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger, () => clock);
    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    const child = { exitCode: null as number | null, killed: false };
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: false }),
      command: vi.fn(async (type: string) => {
        if (type === 'connect') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'connected' }));
        if (type === 'groups') return { type: 'response' as const, ok: true, groups: [] };
        return { type: 'response' as const, ok: true };
      }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, ingestion, 'main', reception, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, onEvent) => {
        emitEvent = onEvent;
        return bridge;
      },
    });
    const messageBase = { groupId: 'provider@g.us', messageId: 'retry-photo', timestampMs: clock - 30_000, fromMe: false };

    try {
      await connector.connect();
      await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
      await vi.waitFor(() => expect(reception.snapshot('main').recoveryStartedAt).not.toBeNull());
      emitEvent?.({ type: 'event', event: 'message', message: { ...messageBase, type: 'decrypt-failed' } });
      await vi.waitFor(() => expect(reception.snapshot('main').decryptFailureCount).toBe(1));

      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';
      const recovered = { ...messageBase, type: 'notify' as const, text: 'COD 143 PRECIO $60.000', imageBase64: png, mimeType: 'image/png' };
      emitEvent?.({ type: 'event', event: 'message', message: recovered });
      await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 1 }));
      expect(reception.snapshot('main')).toMatchObject({ decryptFailureCount: 0, failedCount: 0 });
      expect(db.prepare("SELECT COUNT(*) as count FROM application_logs WHERE action='supplier.message.decrypt.recovered'").get()).toEqual({ count: 1 });

      emitEvent?.({ type: 'event', event: 'message', message: recovered });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 1 });
      expect(JSON.stringify(db.prepare('SELECT message,details_json FROM application_logs').all())).not.toContain('COD 143 PRECIO $60.000');
    } finally {
      await connector.close();
      await reception.close();
      db.close();
    }
  });

  it('retries a transient initial dial failure for an unpaired account until the QR can be generated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T10:00:00-05:00'));
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-initial-retry-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const logger = pino({ level: 'silent' });
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    const child = { exitCode: null as number | null, killed: false };
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 1) throw Object.assign(new Error('websocket reset'), { retryable: true });
      queueMicrotask(() => emitEvent?.({ type: 'event', event: 'qr', qr: 'qr-after-retry' }));
      return { type: 'response' as const, ok: true };
    });
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: false }),
      command: vi.fn(async (type: string) => type === 'connect' ? connect() : { type: 'response' as const, ok: true }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, undefined, 'main', undefined, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, onEvent) => {
        emitEvent = onEvent;
        return bridge;
      },
    });

    try {
      await expect(connector.connect()).rejects.toThrow('websocket reset');
      expect(connector.status()).toMatchObject({
        status: 'disconnected',
        reconnectScheduled: true,
        lastError: 'La conexión inicial falló por un error temporal; se volverá a intentar automáticamente.',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(connector.status()).toMatchObject({ status: 'qr', qr: 'qr-after-retry' }));
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connector.status().reconnectScheduled).toBe(false);
    } finally {
      await connector.close();
      db.close();
    }
  });

  it('exposes a pending library reconnect and lets disconnect cancel it', async () => {
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-cancel-reconnect-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const logger = pino({ level: 'silent' });
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    let emitEvent: ((event: WhatsmeowSidecarEvent) => void) | undefined;
    const child = { exitCode: null as number | null, killed: false };
    const bridge = {
      child,
      ready: Promise.resolve({ type: 'ready' as const, paired: true }),
      command: vi.fn(async (type: string) => {
        if (type === 'connect') queueMicrotask(() => emitEvent?.({ type: 'event', event: 'connected' }));
        return { type: 'response' as const, ok: true };
      }),
      shutdown: vi.fn(async () => { child.exitCode = 0; }),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, undefined, 'main', undefined, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, onEvent) => {
        emitEvent = onEvent;
        return bridge;
      },
    });

    try {
      await connector.connect();
      await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
      emitEvent?.({ type: 'event', event: 'disconnected' });
      expect(connector.status()).toMatchObject({ status: 'disconnected', reconnectScheduled: true });
      await connector.disconnect();
      expect(connector.status()).toMatchObject({ status: 'disconnected', reconnectScheduled: false });
    } finally {
      await connector.close();
      db.close();
    }
  });

  it('reports an interrupted history attempt and reconnects a previously paired session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T10:00:00-05:00'));
    vi.stubEnv('WHATSMEOW_BINARY', process.execPath);
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-reconnect-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='00:00',reception_end_time='23:59' WHERE session_id='main'").run();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Proveedor',0,?,?)")
      .run(now, now);
    db.prepare(`INSERT INTO whatsapp_history_anchors(session_id,group_jid,message_id,message_timestamp_ms,from_me,participant_jid)
      VALUES ('main','provider@g.us','history-anchor',?,0,'vendor@s.whatsapp.net')`).run(Date.now() - 60_000);
    const logger = pino({ level: 'silent' });
    const ingestion = new SupplierIngestionService(db, directory, logger);
    const reception = new SupplierReceptionService(db, directory, ingestion, logger);
    const bridges: Array<{
      child: { exitCode: number | null; killed: boolean };
      calls: Array<{ type: string; payload: Record<string, unknown> }>;
      emit: (event: WhatsmeowSidecarEvent) => void;
      exit: (code: number | null, signal: NodeJS.Signals | null) => void;
    }> = [];
    const protector = {
      protect: async (data: Buffer) => Buffer.from(data),
      unprotect: async (data: Buffer) => Buffer.from(data),
    };
    const connector = new WhatsmeowConnector(db, directory, logger, true, ingestion, 'main', reception, {
      protector,
      bridgeFactory: (_binary, _databasePath, _key, emit, exit) => {
        const index = bridges.length;
        const child = { exitCode: null as number | null, killed: false };
        const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const bridge = {
          child,
          ready: Promise.resolve({ type: 'ready' as const, paired: index > 0 }),
          command: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
            calls.push({ type, payload });
            if (type === 'connect' && index > 0) queueMicrotask(() => emit({ type: 'event', event: 'connected' }));
            if (type === 'groups') return { type: 'response' as const, ok: true, groups: [] };
            return { type: 'response' as const, ok: true };
          }),
          shutdown: vi.fn(async () => { child.exitCode = 0; }),
        };
        bridges.push({ child, calls, emit, exit });
        return bridge;
      },
    });

    try {
      await connector.connect();
      bridges[0]!.emit({ type: 'event', event: 'paired' });
      await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM whatsapp_auth_records WHERE session_id='main' AND record_type='whatsmeow-state' AND record_id='paired'").get()).toBeTruthy());
      bridges[0]!.emit({ type: 'event', event: 'connected' });
      await vi.waitFor(() => expect(bridges[0]!.calls.some((call) => call.type === 'history')).toBe(true));

      bridges[0]!.child.exitCode = 1;
      bridges[0]!.exit(1, null);
      await vi.waitFor(() => expect(reception.snapshot('main')).toMatchObject({ recoveryInterruptedGroups: 1, recoveryStatus: 'unavailable' }));
      expect(connector.status()).toMatchObject({ status: 'disconnected', lastError: 'El proceso de WhatsApp se cerró; se intentará restablecer la conexión.' });

      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(connector.status().status).toBe('connected'));
      await vi.waitFor(() => expect(bridges[1]!.calls.some((call) => call.type === 'history')).toBe(true));
      expect(bridges).toHaveLength(2);
      expect(connector.status().lastError).toBeNull();
    } finally {
      await connector.close();
      await reception.close();
      db.close();
    }
  });

  it('resets only the selected WhatsApp pairing while preserving catalog and other accounts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'whatsmeow-reset-isolation-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Secundaria',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('secondary','[]',?)").run(now);
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('secondary','stopped',?)").run(now);
    db.prepare("INSERT INTO whatsapp_auth_meta(name,value) VALUES ('data_key_protected','protected-master-key')").run();
    db.prepare(`INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES
      ('main','whatsmeow-state','paired','main-pairing'),('main','creds','main','legacy-main'),
      ('secondary','whatsmeow-state','paired','secondary-pairing')`).run();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id)
      VALUES ('kept-product','Catálogo','Texto de proveedor','{}','needs_review',?,?,'main')`).run(now, now);
    const storeDirectory = join(directory, 'whatsmeow');
    mkdirSync(storeDirectory, { recursive: true });
    const mainStore = join(storeDirectory, 'main.sqlite');
    const secondaryStore = join(storeDirectory, 'secondary.sqlite');
    writeFileSync(mainStore, 'main encrypted store');
    writeFileSync(`${mainStore}-wal`, 'main wal');
    writeFileSync(secondaryStore, 'secondary encrypted store');
    const logger = pino({ level: 'silent' });
    const connector = new WhatsmeowConnector(db, directory, logger, true, new SupplierIngestionService(db, directory, logger));

    try {
      await connector.resetSession();
      expect(db.prepare('SELECT session_id,record_type,record_id FROM whatsapp_auth_records ORDER BY session_id,record_type').all()).toEqual([
        { session_id: 'secondary', record_type: 'whatsmeow-state', record_id: 'paired' },
      ]);
      expect(db.prepare('SELECT id,raw_text,session_id FROM products WHERE id=?').get('kept-product')).toEqual({ id: 'kept-product', raw_text: 'Texto de proveedor', session_id: 'main' });
      expect(existsSync(mainStore)).toBe(false);
      expect(existsSync(`${mainStore}-wal`)).toBe(false);
      expect(existsSync(secondaryStore)).toBe(true);
      expect(db.prepare("SELECT COUNT(*) as count FROM whatsapp_auth_meta WHERE name='data_key_protected'").get()).toEqual({ count: 1 });
    } finally {
      await connector.close();
      db.close();
    }
  });
});
