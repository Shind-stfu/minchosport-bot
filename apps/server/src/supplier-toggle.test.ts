import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(inspectImageText?: (bytes: Buffer) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-supplier-toggle-'));
  directories.push(directory);
  const databaseFile = join(directory, 'business.sqlite');
  const db = openDatabase(databaseFile);
  const now = new Date().toISOString();
  for (const id of ['first', 'second']) db.prepare(`INSERT INTO supplier_profiles
    (id,session_id,source_group_id,name,margin_cop,box_margin_cop,marker_text,default_position,created_at,updated_at)
    VALUES (?,'main',?,?,10000,5000,'🌎','bottom_right',?,?)`).run(id, `${id}@g.us`, id, now, now);
  const logger = Fastify({ logger: false }).log;
  const ingestion = new SupplierIngestionService(db, directory, logger, undefined, inspectImageText);
  const reception = new SupplierReceptionService(db, directory, ingestion, logger);
  const app = createApp({ db, dataDirectory: directory, supplierReception: reception, logLevel: 'silent' });
  const toggle = (enabled: boolean) => app.inject({ method: 'PATCH', url: '/api/providers/first/reception',
    headers: { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:5174' }, payload: { enabled } });
  return { app, db, databaseFile, directory, ingestion, reception, toggle };
}

describe('supplier reception toggle', () => {
  it('pauses one supplier, preserves products and rules, and resumes only new messages after restart', async () => {
    const now = Date.parse('2026-11-23T15:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const { app, db, databaseFile, ingestion, reception, toggle } = setup();
    const original = db.prepare("SELECT * FROM supplier_profiles WHERE id='first'").get() as Record<string, unknown>;
    const message = { sessionId: 'main', groupId: 'first@g.us', text: 'COD 168 LE COQ HOMBRE $85.000', timestampMs: now - 1000 };
    expect(await reception.capture({ ...message, messageId: 'already-received' })).toBe('stored');
    expect(await reception.capture({ ...message, messageId: 'queued' }, true)).toBe('pending');
    expect((await toggle(false)).json()).toMatchObject({ receptionEnabled: false });
    expect(ingestion.isSupplierGroup('first@g.us')).toBe(false);
    expect(ingestion.isSupplierGroup('second@g.us')).toBe(true);
    expect(db.prepare("SELECT status FROM supplier_inbox_messages WHERE message_id='queued'").get()).toEqual({ status: 'ignored' });
    expect(db.prepare("SELECT * FROM supplier_profiles WHERE id='first'").get()).toMatchObject({
      ...original, reception_enabled: 0, updated_at: new Date(now).toISOString(), archived_at: null,
    });
    expect(await ingestion.receive({ ...message, messageId: 'while-paused' })).toBe('ignored');
    expect(await reception.capture({ ...message, groupId: 'second@g.us', messageId: 'other-provider' })).toBe('stored');
    const catalog = await app.inject({ url: '/api/sessions/main/providers', headers: { host: '127.0.0.1:3210' } });
    expect(catalog.json()).toHaveLength(2);
    expect(catalog.json().find((provider: { id: string }) => provider.id === 'first')).toMatchObject({ receptionEnabled: false });
    await app.close(); await reception.close(); db.close();

    // State survives a fresh database connection, and retrying the same state
    // does not create another activation window.
    const reopened = openDatabase(databaseFile);
    expect(reopened.prepare("SELECT reception_enabled FROM supplier_profiles WHERE id='first'").get()).toEqual({ reception_enabled: 0 });
    const secondApp = createApp({ db: reopened, dataDirectory: directories.at(-1)!, logLevel: 'silent' });
    clock.mockReturnValue(now + 60_000);
    const activate = () => secondApp.inject({ method: 'PATCH', url: '/api/providers/first/reception', headers: { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:5174' }, payload: { enabled: true } });
    expect((await activate()).json()).toMatchObject({ receptionEnabled: true });
    clock.mockReturnValue(now + 120_000);
    await activate();
    const restarted = new SupplierIngestionService(reopened, directories.at(-1)!, Fastify({ logger: false }).log);
    expect(await restarted.receive({ ...message, messageId: 'delayed-paused-history', timestampMs: now + 30_000, receptionMode: 'recovery' })).toBe('ignored');
    expect(await restarted.receive({ ...message, messageId: 'new-message', timestampMs: now + 61_000 })).toBe('stored');
    expect(reopened.prepare('SELECT COUNT(*) count FROM products').get()).toEqual({ count: 3 });
    expect(reopened.prepare("SELECT COUNT(*) count FROM application_logs WHERE action LIKE 'supplier.reception.%'").get()).toEqual({ count: 2 });
    await secondApp.close(); reopened.close();
  });

  it('rechecks reception after an in-flight OCR finishes', async () => {
    let completeOcr!: (text: string) => void;
    const ocr = new Promise<string>((resolve) => { completeOcr = resolve; });
    const { app, db, ingestion, reception, toggle } = setup(() => ocr);
    const pending = ingestion.receive({ groupId: 'first@g.us', messageId: 'in-flight', timestampMs: Date.now(), text: '',
      image: { mimeType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]) } });
    expect((await toggle(false)).statusCode).toBe(200);
    completeOcr('');
    expect(await pending).toBe('ignored');
    expect(db.prepare('SELECT COUNT(*) count FROM products').get()).toEqual({ count: 0 });
    await app.close(); await reception.close(); db.close();
  });

  it('rejects invalid toggle requests and unknown or archived suppliers', async () => {
    const { app, db, reception } = setup();
    const headers = { host: '127.0.0.1:3210' };
    expect((await app.inject({ method: 'PATCH', url: '/api/providers/first/reception', headers, payload: { enabled: 'false' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/providers/missing/reception', headers, payload: { enabled: false } })).statusCode).toBe(404);
    db.prepare("UPDATE supplier_profiles SET archived_at=? WHERE id='first'").run(new Date().toISOString());
    expect((await app.inject({ method: 'PATCH', url: '/api/providers/first/reception', headers, payload: { enabled: true } })).statusCode).toBe(404);
    await app.close(); await reception.close(); db.close();
  });

  it.each(['http://example.com:5174', 'http://127.0.0.1:9999', 'http://127.0.0.1.attacker.test:5174'])(
    'rejects supplier changes from an untrusted origin: %s', async (origin) => {
      const { app, db, reception } = setup();
      const response = await app.inject({ method: 'PATCH', url: '/api/providers/first/reception',
        headers: { host: '127.0.0.1:3210', origin }, payload: { enabled: false } });
      expect(response.statusCode).toBe(403);
      expect(db.prepare("SELECT reception_enabled FROM supplier_profiles WHERE id='first'").get()).toEqual({ reception_enabled: 1 });
      await app.close(); await reception.close(); db.close();
    });
});
