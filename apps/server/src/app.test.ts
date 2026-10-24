import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { writeApplicationLog } from './application-log.js';
import { renderMarkedImage } from './image-marking.js';
import sharp from 'sharp';
import type { WhatsAppConnector } from './whatsapp.js';
import type { ImageInspection } from './image-inspection.js';

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(whatsapp?: WhatsAppConnector, imageInspector?: { inspect: (source: Buffer) => Promise<ImageInspection> }) {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-server-'));
  temporaryDirectories.push(directory);
  const db = openDatabase(join(directory, 'business.sqlite'));
  const app = createApp({ db, dataDirectory: directory, logLevel: 'silent', ...(whatsapp ? { whatsapp } : {}), ...(imageInspector ? { imageInspector } : {}), messagingEnabled: Boolean(whatsapp) });
  return { app, db };
}

describe('local simulation API', () => {
  it('requests history when saving a connected account range and supports manual retries without disconnecting', async () => {
    let requests = 0; let disconnects = 0; let connected = true;
    const connector: WhatsAppConnector = {
      status: () => ({ status: connected ? 'connected' : 'disconnected', qr: null, lastError: null }), connect: async () => {}, disconnect: async () => { disconnects += 1; }, resetSession: async () => {},
      listGroups: async () => [], sendImage: async () => ({ messageId: 'x' }), requestHistory: async () => { requests += 1; },
    };
    const { app } = setup(connector);
    const headers = { host: '127.0.0.1:3210' };
    const saved = await app.inject({ method: 'PUT', url: '/api/sessions/main/reception-schedule', headers: { ...headers, 'content-type': 'application/json' }, payload: { startTime: '17:00', endTime: '20:00' } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ recoveryRequested: true, receptionSchedule: { startTime: '17:00', endTime: '20:00' } });
    expect(requests).toBe(1);
    const retried = await app.inject({ method: 'POST', url: '/api/sessions/main/recover-history', headers });
    expect(retried.statusCode).toBe(202); expect(requests).toBe(2); expect(disconnects).toBe(0);
    const missing = await app.inject({ method: 'POST', url: '/api/sessions/missing/recover-history', headers });
    expect(missing.statusCode).toBe(404); expect(requests).toBe(2);
    connected = false;
    const offline = await app.inject({ method: 'POST', url: '/api/sessions/main/recover-history', headers });
    expect(offline.statusCode).toBe(409); expect(requests).toBe(2);
    await app.close();
  });

  it('exposes per-account reception hours and keeps the catalog when the schedule changes', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('schedule-product','Tenis','COD 143','{}','needs_review',?,?,'main')").run(now, now);
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const initial = await app.inject({ method: 'GET', url: '/api/sessions/main', headers });
    expect(initial.json().receptionSchedule).toEqual({ startTime: '16:00', endTime: '19:00', timeZone: 'America/Bogota' });
    expect(initial.json().receptionQueue).toMatchObject({ pendingCount: 0, failedCount: 0, recoveryStatus: 'idle' });
    const invalid = await app.inject({ method: 'PUT', url: '/api/sessions/main/reception-schedule', headers, payload: { startTime: '09:00', endTime: '09:00' } });
    expect(invalid.statusCode).toBe(400);
    const updated = await app.inject({ method: 'PUT', url: '/api/sessions/main/reception-schedule', headers, payload: { startTime: '10:00', endTime: '20:00' } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().receptionSchedule).toEqual({ startTime: '10:00', endTime: '20:00', timeZone: 'America/Bogota' });
    expect(db.prepare("SELECT COUNT(*) as count FROM products WHERE id='schedule-product'").get()).toEqual({ count: 1 });
    await app.close();
  });

  it('persists local image inspection results and returns them with the catalog photo', async () => {
    const inspection: ImageInspection = {
      ocrText: 'COD 001 · NIKE', ocrConfidence: 0.91, ocrError: null,
      codeCandidates: [{ code: '001', confidence: 0.89, evidence: 'label' }],
      detectedCode: '001', detectedCodeConfidence: 0.89,
      world: { detected: true, variant: '🌎', confidence: 0.94, bounds: { left: 120, top: 230, width: 32, height: 32 } },
    };
    const { app, db } = setup(undefined, { inspect: async () => inspection });
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const image = await sharp({ create: { width: 200, height: 160, channels: 3, background: { r: 200, g: 210, b: 190 } } }).png().toBuffer();
    const hash = createHash('sha256').update(image).digest('hex'); const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), image);
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at) VALUES ('inspection-product','Tenis','COD 001','{}','needs_review',?,?)").run(now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run('inspection-asset','inspection-product',hash,fileName,'image/png',image.length,now);

    const headers = { host: '127.0.0.1:3210' };
    const result = await app.inject({ method: 'POST', url: '/api/products/inspection-product/inspect-image', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ inspections: [{ assetId: 'inspection-asset', inspection: { detectedCode: '001', world: { detected: true, variant: '🌎' } } }], errors: [] });
    expect(db.prepare('SELECT ocr_confidence,ocr_error,detected_code,world_variant FROM image_inspections WHERE media_asset_id=?').get('inspection-asset')).toEqual({ ocr_confidence: 0.91, ocr_error: null, detected_code: '001', world_variant: '🌎' });

    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].inspection).toMatchObject({ ocrText: 'COD 001 · NIKE', detectedCode: '001', codeCandidates: [{ code: '001' }], world: { detected: true, variant: '🌎' } });
    await app.close();
  });

  it('blocks an uncertain photo in the preview until the operator confirms the original', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const image = await sharp({ create: { width: 240, height: 180, channels: 3, background: '#dddddd' } }).png().toBuffer();
    const hash = createHash('sha256').update(image).digest('hex');
    writeFileSync(join(directory, 'media', `${hash}.png`), image);
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,shoe_code,marker_text_applied,image_position) VALUES ('review-photo','Tenis','COD 960','{}','approved',?,?,'main','960','🌍','top_left')").run(now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run('review-asset','review-photo',hash,`${hash}.png`,'image/png',image.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run('review-asset', JSON.stringify([{ corner: 'top_left', text: '999 🌍', code: '999', hasWorld: true, worldUncertain: false }]), now);
    const headers = { host: '127.0.0.1:3210' };
    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].marking).toMatchObject({ status: 'review', mode: null });
    const blockedPreview = await app.inject({ method: 'GET', url: '/api/products/review-photo/preview?assetId=review-asset', headers });
    expect(blockedPreview.rawPayload).toEqual(image);
    const selected = await app.inject({ method: 'PUT', url: '/api/products/review-photo/images/review-asset/marking', headers: { ...headers, 'content-type': 'application/json' }, payload: { mode: 'original' } });
    expect(selected.statusCode).toBe(200);
    const resolved = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(resolved.json()[0].images[0].marking).toMatchObject({ status: 'ready', mode: 'original', manual: true });
    const readyPreview = await app.inject({ method: 'GET', url: '/api/products/review-photo/preview?assetId=review-asset', headers });
    expect(readyPreview.rawPayload).toEqual(image);
    await app.close();
  });

  it('keeps original bytes when a stored corner scan reads 954A beside an existing globe', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const original = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ccc' } }).png().toBuffer();
    const hash = createHash('sha256').update(original).digest('hex');
    const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), original);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,shoe_code,marker_text_applied,image_position)
      VALUES ('already-marked-954','Tenis','COD 954 · $80.000','{}','needs_review',?,?,'main','954','🌍','top_left')`).run(now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run('already-marked-asset','already-marked-954',hash,fileName,'image/png',original.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run('already-marked-asset', JSON.stringify([
        { corner: 'top_left', text: '- —\n954A © LW\nY “e', code: null, hasWorld: true, worldUncertain: false },
      ]), now);

    const headers = { host: '127.0.0.1:3210' };
    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].marking).toMatchObject({ status: 'ready', mode: 'original' });
    const preview = await app.inject({ method: 'GET', url: '/api/products/already-marked-954/preview', headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toEqual(original);
    await app.close();
  });

  it('marks the caption code after HOMBRE and an emoji on an existing unedited product', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#d8d4ce' } }).png().toBuffer();
    const hash = createHash('sha256').update(original).digest('hex');
    const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), original);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,marker_text_applied,image_position)
      VALUES ('caption-code','BAPE','*HOMBRE 🕴️174-54*\n*$100.000*','{}','needs_review',?,?,'main','🌎','top_left')`).run(now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run('caption-code-asset','caption-code',hash,fileName,'image/png',original.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete','[]',?)")
      .run('caption-code-asset', now);

    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers: { host: '127.0.0.1:3210' } });
    expect(catalog.json()[0]).toMatchObject({ shoe_code: '174-54', images: [{ marking: { status: 'ready', mode: 'mark_all' } }] });
    const preview = await app.inject({ method: 'GET', url: '/api/products/caption-code/preview', headers: { host: '127.0.0.1:3210' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).not.toEqual(original);
    expect(readFileSync(join(directory, 'media', fileName))).toEqual(original);
    await app.close();
  });

  it('uses a leading reference on an existing product and previews code-only and code-with-world markings', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#d8d4ce' } }).png().toBuffer();
    const hash = createHash('sha256').update(original).digest('hex');
    writeFileSync(join(directory, 'media', `${hash}.png`), original);
    const raw = '1059 *ADIDAS REPÓNSE DAMA $75.000🚀🚀*_Por caja $65.000📦📦_';
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,marker_text_applied,image_position)
      VALUES ('leading-reference','ADIDAS',?,'{}','needs_review',?,?,'main','🌎','bottom_right')`).run(raw, now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run('leading-photo','leading-reference',hash,`${hash}.png`,'image/png',original.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES ('leading-photo','complete','[]',?)").run(now);
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0]).toMatchObject({ shoe_code: '1059', images: [{ marking: { mode: 'mark_all' } }] });
    for (const mode of ['mark_code', 'mark_all'] as const) {
      const result = await app.inject({ method: 'PUT', url: '/api/products/leading-reference/images/leading-photo/marking', headers, payload: { mode } });
      expect(result.statusCode, result.body).toBe(200);
      const preview = await app.inject({ method: 'GET', url: '/api/products/leading-reference/preview', headers });
      const expected = await renderMarkedImage(original, { code: '1059', genderIndicator: 'D', marker: '🌎', position: 'bottom_right', sourceHasWorld: mode === 'mark_code' });
      expect(preview.rawPayload).toEqual(expected.bytes);
    }
    // A deliberate removal still wins over the inferred description code.
    await app.inject({ method: 'PUT', url: '/api/products/leading-reference/image-options', headers, payload: { shoeCode: null, position: 'bottom_right' } });
    const removed = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(removed.json()[0].shoe_code).toBeNull();
    await app.close();
  });

  it('keeps the send interval separate by account and rejects values below the minimum', async () => {
    const { app, db } = setup();
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { name: 'Cuenta lenta' } });
    const otherSessionId = created.json().id as string;
    const initial = await app.inject({ method: 'GET', url: `/api/sessions/${otherSessionId}`, headers });
    expect(initial.json().sendIntervalMs).toBe(10000);
    const invalid = await app.inject({ method: 'PUT', url: `/api/sessions/${otherSessionId}/send-interval`, headers, payload: { sendIntervalMs: 1000 } });
    expect(invalid.statusCode).toBe(400);
    const updated = await app.inject({ method: 'PUT', url: `/api/sessions/${otherSessionId}/send-interval`, headers, payload: { sendIntervalMs: 30000 } });
    expect(updated.statusCode).toBe(200);
    expect(db.prepare('SELECT session_id,send_interval_ms FROM whatsapp_session_settings WHERE session_id=?').get('main')).toEqual({ session_id: 'main', send_interval_ms: 10000 });
    expect(db.prepare('SELECT session_id,send_interval_ms FROM whatsapp_session_settings WHERE session_id=?').get(otherSessionId)).toEqual({ session_id: otherSessionId, send_interval_ms: 30000 });
    await app.close();
  });

  it('deletes an already sent product and its local photos while preserving the deletion activity', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    const imagePath = join(directory, 'media', 'sent.png');
    writeFileSync(imagePath, Buffer.from('photo'));
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id)
      VALUES ('sent-product','Tenis enviado','COD 143','{}','approved',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id)
      VALUES ('shared-product','Otro producto','COD 144','{}','needs_review',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at)
      VALUES ('sent-asset','sent-product','sent-hash','sent.png','image/png',5,0,?)`).run(now);
    db.prepare(`INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at)
      VALUES ('shared-asset','shared-product','sent-hash','sent.png','image/png',5,0,?)`).run(now);
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('sent-publication','sent-product','buyers@g.us','Clientes','submitted',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id)
      VALUES ('sent-unit','sent-publication',0,'sent-asset','submitted','main')`).run();

    const response = await app.inject({ method: 'DELETE', url: '/api/products/sent-product', headers: { host: '127.0.0.1:3210' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, productCount: 1, imageCount: 1, deletedFiles: 0, fileErrors: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM products WHERE id=?').get('sent-product')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM products WHERE id=?').get('shared-product')).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications WHERE product_id=?').get('sent-product')).toEqual({ count: 0 });
    expect(db.prepare(`SELECT action,message FROM application_logs WHERE action='products.deleted.manually'`).get())
      .toEqual({ action: 'products.deleted.manually', message: 'Se eliminó un producto enviado del catálogo' });
    expect(readFileSync(imagePath)).toEqual(Buffer.from('photo'));
    await app.close();
  });

  it('refuses to delete a product with an uncertain or in-progress send', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id)
      VALUES ('uncertain-product','Tenis pendiente','COD 143','{}','approved',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('uncertain-publication','uncertain-product','buyers@g.us','Clientes','needs_review',?,?,'main')`).run(now, now);
    const response = await app.inject({ method: 'DELETE', url: '/api/products/uncertain-product', headers: { host: '127.0.0.1:3210' } });
    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) as count FROM products WHERE id=?').get('uncertain-product')).toEqual({ count: 1 });
    await app.close();
  });

  it('bulk-deletes settled sent products only for the selected account provider and preserves uncertain ones', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-delete-a','main','source-a@g.us','Bodega A',10000,'🌎','bottom_right',?,?),
        ('supplier-delete-b','main','source-b@g.us','Bodega B',10000,'🌎','bottom_right',?,?)`).run(now, now, now, now);
    for (const [id, supplierId, status, groupId] of [
      ['sent-a-1', 'supplier-delete-a', 'submitted', 'buyers-a@g.us'],
      ['sent-a-2', 'supplier-delete-a', 'submitted', 'buyers-a2@g.us'],
      ['sent-b', 'supplier-delete-b', 'submitted', 'buyers-b@g.us'],
    ]) {
      db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id)
        VALUES (?,?,'COD 143','{}','approved',?,?,'main',?)`).run(id, id, now, now, supplierId);
      db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
        VALUES (?,?,?,'Clientes',?,?,?,'main')`).run(`publication-${id}`, id, groupId, status, now, now);
    }
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication-uncertain-a2','sent-a-2','buyers-uncertain@g.us','Clientes','needs_review',?,?,'main')`).run(now, now);
    const response = await app.inject({
      method: 'DELETE', url: '/api/sessions/main/products/sent', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' },
      payload: { supplierId: 'supplier-delete-a' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ productCount: 1, skippedUncertainOrInProgress: 1 });
    expect(db.prepare('SELECT id FROM products ORDER BY id').all()).toEqual([{ id: 'sent-a-2' }, { id: 'sent-b' }]);
    await app.close();
  });

  it('returns readable activity only for the requested account and parses event details', async () => {
    const { app, db } = setup();
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { name: 'Cuenta de actividad' } });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;
    const accountLogs = await app.inject({ method: 'GET', url: `/api/logs?sessionId=${sessionId}`, headers });
    expect(accountLogs.statusCode).toBe(200);
    expect(accountLogs.json()).toHaveLength(1);
    expect(accountLogs.json()[0]).toMatchObject({
      sessionId, sessionName: 'Cuenta de actividad', action: 'whatsapp.session.created',
      category: 'connection', message: 'Se creó una cuenta de WhatsApp', details: { name: 'Cuenta de actividad' },
    });
    writeApplicationLog(db, { sessionId: 'main', category: 'connection', action: 'test.safe-details', entityType: 'whatsapp_session', entityId: 'main', message: 'Detalle de seguridad', details: { imageCount: 1, qr: 'qr-secreto', token: 'token-secreto' } });
    db.prepare(`INSERT INTO application_logs(id,session_id,level,category,action,entity_type,entity_id,message,details_json,created_at)
      VALUES ('legacy-whatsapp-log','main','info','settings','whatsapp.connected','whatsapp','main','Conexión heredada','{}','2026-01-01T00:00:00.000Z')`).run();
    const mainLogs = await app.inject({ method: 'GET', url: '/api/logs?sessionId=main', headers });
    expect(mainLogs.json()).toHaveLength(2);
    expect(mainLogs.json()[0]).toMatchObject({ message: 'Detalle de seguridad', details: { imageCount: 1 } });
    expect(mainLogs.json().find((log: { action: string }) => log.action === 'whatsapp.connected')).toMatchObject({ category: 'connection' });
    expect(mainLogs.body).not.toContain('qr-secreto');
    expect(mainLogs.body).not.toContain('token-secreto');
    const missing = await app.inject({ method: 'GET', url: '/api/logs?sessionId=missing', headers });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('shows migrated and supplier-group products in the catalog without deleting historical entries', async () => {
    const { app, db } = setup();
    db.prepare("UPDATE whatsapp_settings SET source_group_id='supplier@g.us' WHERE id=1").run();
    const insert = db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
    insert.run('from-supplier', 'Tenis proveedor', 'Tallas 36-40', '{}', 'needs_review', '2026-01-02', '2026-01-02');
    insert.run('manual-only', 'Carga manual', 'Tallas 36-40', '{}', 'needs_review', '2026-01-03', '2026-01-03');
    db.prepare("INSERT INTO whatsapp_product_assemblies(product_id,group_jid,participant_jid,last_message_at,media_count,status,association_confident) VALUES ('from-supplier','supplier@g.us','vendor@s.whatsapp.net','2026-01-02',1,'closed',1)").run();
    const response = await app.inject({ method: 'GET', url: '/api/products', headers: { host: '127.0.0.1:3210' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((product: { id: string }) => product.id)).toEqual(['manual-only', 'from-supplier']);
    await app.close();
  });

  it('recalculates old product analysis and applies the margin when approving an abbreviated COP price', async () => {
    const { app, db } = setup();
    const rawText = '*NIKE DUNK LOW JARRITO / SB* HOMBRE _COD: 987👑_ EUR 41 AL 44 PARES *$70👟*';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-price','main','supplier@g.us','Bodega',10000,'🌎','bottom_right',?,?)`).run(now, now);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied)
      VALUES ('abbreviated-price','Nike Dunk',?,'{"status":"no_price","candidates":[],"excluded":[]}','needs_review',?,?,'main','supplier-price',10000)`)
      .run(rawText, now, now);

    const listed = await app.inject({ method: 'GET', url: '/api/products', headers: { host: '127.0.0.1:3210' } });
    expect(listed.json()[0].analysis.candidates[0]).toMatchObject({ amountCop: 70000 });
    const approved = await app.inject({
      method: 'POST', url: '/api/products/abbreviated-price/approve',
      headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' },
      payload: { sourcePriceCop: 70000, outputText: rawText },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ finalPriceCop: 80000, outputText: '*NIKE DUNK LOW JARRITO / SB HOMBRE COD: 987 EUR 41 AL 44 PARES $80.000*' });
    expect(db.prepare('SELECT source_price_cop,final_price_cop,output_text,status FROM products WHERE id=?').get('abbreviated-price'))
      .toEqual({ source_price_cop: 70000, final_price_cop: 80000, output_text: '*NIKE DUNK LOW JARRITO / SB HOMBRE COD: 987 EUR 41 AL 44 PARES $80.000*', status: 'approved' });
    await app.close();
  });

  it('approves PRECIO and CAJA with independent supplier margins, including zero for pre-adjusted suppliers', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    const text = 'Vans dama\n*PRECIO $45.000*👟\n*CAJA $35.000📦*';
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,box_margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-vans','main','supplier@g.us','Bodega Vans',10000,5000,'🌎⭐','bottom_right',?,?)`).run(now,now);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,box_margin_cop_applied)
      VALUES ('vans-price-box','Vans dama',?,'{}','needs_review',?,?,'main','supplier-vans',10000,5000)`).run(text,now,now);
    const approved = await app.inject({ method: 'POST', url: '/api/products/vans-price-box/approve', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { sourcePricesCop: [45000,35000], outputText: text } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ sourcePricesCop: [45000,35000], finalPricesCop: [55000,40000], outputText: '*VANS DAMA*\n*PRECIO $55.000*\n*CAJA $40.000*' });

    db.prepare('UPDATE products SET status=\'needs_review\',output_text=NULL,updated_at=? WHERE id=\'vans-price-box\'').run(now);
    db.prepare('UPDATE products SET margin_cop_applied=0,box_margin_cop_applied=0 WHERE id=\'vans-price-box\'').run();
    const unchanged = await app.inject({ method: 'POST', url: '/api/products/vans-price-box/approve', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { sourcePricesCop: [45000,35000], outputText: text } });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json()).toMatchObject({ finalPricesCop: [45000,35000], outputText: '*VANS DAMA*\n*PRECIO $45.000*\n*CAJA $35.000*' });
    await app.close();
  });

  it('removes DOCENA pricing from the outgoing text while retaining it in the received source', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    const received = '🦅REF 292 D🦅\nPRECIO $55.000👟\nDOCENA $50.000📦';
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,box_margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-docena','main','supplier@g.us','Bodega',0,5000,'🌎⭐','bottom_right',?,?)`).run(now,now);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,box_margin_cop_applied)
      VALUES ('docena-product','Referencia 292',?,'{}','needs_review',?,?,'main','supplier-docena',0,5000)`).run(received,now,now);
    const approved = await app.inject({ method: 'POST', url: '/api/products/docena-product/approve', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { sourcePriceCop: 55000, outputText: received } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ outputText: '*REF 292 D*\n*PRECIO $55.000*', finalPriceCop: 55000 });
    expect(db.prepare('SELECT raw_text,output_text FROM products WHERE id=\'docena-product\'').get()).toEqual({ raw_text: received, output_text: '*REF 292 D*\n*PRECIO $55.000*' });
    await app.close();
  });

  it('rejects a non-local Host header', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'example.com' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a sixth target group and does not persist it', async () => {
    const { app, db } = setup();
    const groups = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `Grupo ${i}` }));
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { marginCop: 5000, targetGroups: groups } });
    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT margin_cop FROM settings').get()).toEqual({ margin_cop: 10000 });
    await app.close();
  });

  it('records simulation locally per group without any sending adapter', async () => {
    const { app, db } = setup();
    db.prepare('UPDATE settings SET target_groups=? WHERE id=1').run(JSON.stringify([{ id: 'test-a', name: 'Prueba A' }, { id: 'test-b', name: 'Prueba B' }]));
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at) VALUES ('p1','Tenis','Precio $60.000','{}',60000,70000,'Precio $70.000','approved','2026-01-01','2026-01-01')").run();
    const response = await app.inject({ method: 'POST', url: '/api/products/p1/simulate', headers: { host: '127.0.0.1:3210' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe('simulation');
    expect(db.prepare('SELECT group_id, status, mode FROM deliveries ORDER BY group_id').all()).toEqual([
      { group_id: 'test-a', status: 'simulated', mode: 'simulation' },
      { group_id: 'test-b', status: 'simulated', mode: 'simulation' },
    ]);
    await app.close();
  });

  it('stores an uploaded photograph by content hash and serves the same bytes locally', async () => {
    const { app, db } = setup();
    const boundary = 'tenis-test-boundary';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nTenis prueba\r\n--${boundary}\r\nContent-Disposition: form-data; name="rawText"\r\n\r\nPrecio $60.000 · Tallas 36-40\r\n--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="original.png"\r\nContent-Type: image/png\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const response = await app.inject({
      method: 'POST', url: '/api/products',
      headers: { host: '127.0.0.1:3210', 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([header, png, footer]),
    });
    expect(response.statusCode).toBe(201);
    const product = response.json();
    expect(product.images).toHaveLength(1);
    const stored = readFileSync(join(temporaryDirectories.at(-1)!, 'media', `${product.images[0].fileName}`));
    expect(stored).toEqual(png);
    const fetched = await app.inject({ method: 'GET', url: product.images[0].url, headers: { host: '127.0.0.1:3210' } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload).toEqual(png);
    expect(db.prepare('SELECT sha256 FROM media_assets WHERE product_id=?').get(product.id)).toEqual({ sha256: product.images[0].fileName.replace('.png', '') });
    await app.close();
  });

  it('lists only session groups, hides the raw QR token, and persists a valid supplier/target selection', async () => {
    const connector: WhatsAppConnector = {
      status: () => ({ status: 'connected', qr: 'secret-qr-payload', lastError: null }),
      connect: async () => {}, disconnect: async () => {}, resetSession: async () => {},
      listGroups: async () => [{ id: 'supplier@g.us', name: 'Proveedor' }, { id: 'buyers@g.us', name: 'Clientes' }],
      sendImage: async () => ({ messageId: 'sent' }),
    };
    const { app, db } = setup(connector);
    const session = await app.inject({ method: 'GET', url: '/api/whatsapp', headers: { host: '127.0.0.1:3210' } });
    expect(session.statusCode).toBe(200);
    expect(session.json().qr).toBeUndefined();
    expect(session.json().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(session.body).not.toContain('secret-qr-payload');

    const groups = await app.inject({ method: 'GET', url: '/api/whatsapp/groups', headers: { host: '127.0.0.1:3210' } });
    expect(groups.json()).toEqual([{ id: 'buyers@g.us', name: 'Clientes' }, { id: 'supplier@g.us', name: 'Proveedor' }]);
    const selection = await app.inject({ method: 'PUT', url: '/api/whatsapp/selection', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { sourceGroupId: 'supplier@g.us', targetGroupIds: ['buyers@g.us'] } });
    expect(selection.statusCode, selection.body).toBe(200);
    expect(db.prepare('SELECT source_group_id, target_group_ids FROM whatsapp_settings').get()).toEqual({ source_group_id: 'supplier@g.us', target_group_ids: '["buyers@g.us"]' });
    const invalid = await app.inject({ method: 'PUT', url: '/api/whatsapp/selection', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { sourceGroupId: 'supplier@g.us', targetGroupIds: ['missing@g.us'] } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it('resets saved WhatsApp pairing credentials before requesting a fresh QR', async () => {
    const operations: string[] = [];
    const connector: WhatsAppConnector = {
      status: () => ({ status: 'logged_out', qr: null, lastError: null }),
      connect: async () => { operations.push('connect'); },
      disconnect: async () => {},
      resetSession: async () => { operations.push('reset'); },
      listGroups: async () => [],
      sendImage: async () => ({ messageId: 'sent' }),
    };
    const { app } = setup(connector);
    const response = await app.inject({ method: 'POST', url: '/api/whatsapp/reset-pairing', headers: { host: '127.0.0.1:3210' } });
    expect(response.statusCode).toBe(202);
    expect(operations).toEqual(['reset', 'connect']);
    await app.close();
  });

  it('creates independent account records and allows a per-account provider with zero margin', async () => {
    const connector: WhatsAppConnector = {
      status: () => ({ status: 'connected', qr: null, lastError: null }), connect: async () => {}, disconnect: async () => {}, resetSession: async () => {},
      listGroups: async () => [{ id: 'supplier@g.us', name: 'Proveedor' }, { id: 'buyers@g.us', name: 'Clientes' }], sendImage: async () => ({ messageId: 'x' }),
    };
    const { app, db } = setup(connector);
    const groups = await app.inject({ method: 'GET', url: '/api/sessions/main/groups', headers: { host: '127.0.0.1:3210' } });
    expect(groups.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { name: 'Línea secundaria' } });
    expect(created.statusCode).toBe(201);
    const secondaryId = created.json().id as string;
    expect(db.prepare('SELECT COUNT(*) as count FROM whatsapp_sessions').get()).toEqual({ count: 2 });
    db.prepare('INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?)').run(secondaryId,'buyers-2@g.us','Clientes 2',new Date().toISOString());
    const targets = await app.inject({ method: 'PUT', url: `/api/sessions/${secondaryId}/targets`, headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { targetGroupIds: ['buyers-2@g.us'] } });
    expect(targets.statusCode).toBe(200);
    expect(db.prepare('SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id=?').get(secondaryId)).toEqual({ target_group_ids: '["buyers-2@g.us"]' });

    const provider = await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' }, payload: { name: 'Bodega A', sourceGroupId: 'supplier@g.us', marginCop: 0, markerText: '🌎⭐', defaultPosition: 'top_left' } });
    expect(provider.statusCode, provider.body).toBe(201);
    expect(provider.json()).toMatchObject({ sessionId: 'main', priceMarginCop: 0, boxMarginCop: 5000, markerText: '🌎⭐', defaultPosition: 'top_left' });
    expect(db.prepare('SELECT session_id,margin_cop,box_margin_cop FROM supplier_profiles WHERE id=?').get(provider.json().id)).toEqual({ session_id: 'main', margin_cop: 0, box_margin_cop: 5000 });
    await app.close();
  });

  it('preserves saved community destinations and suppliers when refreshing returns only some groups', async () => {
    const child = { id: 'community-child@g.us', name: '#3 Mincho Sport STEFFA Mundo Zapatillas L302' };
    let groups = [child, { id: 'buyers-a@g.us', name: 'Clientes A' }, { id: 'buyers-b@g.us', name: 'Clientes B' }, { id: 'supplier@g.us', name: 'Bodega' }, { id: 'unused@g.us', name: 'Sin configurar' }];
    const connector: WhatsAppConnector = {
      status: () => ({ status: 'connected', qr: null, lastError: null }), connect: async () => {}, disconnect: async () => {}, resetSession: async () => {},
      listGroups: async () => groups, sendImage: async () => ({ messageId: 'unused' }),
    };
    const { app, db } = setup(connector);
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    await app.inject({ method: 'GET', url: '/api/sessions/main/groups', headers });
    const targets = ['buyers-a@g.us', 'buyers-b@g.us', child.id];
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/main/targets', headers, payload: { targetGroupIds: targets } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers, payload: { name: 'Bodega', sourceGroupId: 'supplier@g.us', priceMarginCop: 0, boxMarginCop: 0, markerText: '🌎', defaultPosition: 'top_left' } })).statusCode).toBe(201);
    groups = [{ id: 'buyers-a@g.us', name: 'Clientes A actualizado' }, { id: 'buyers-b@g.us', name: 'Clientes B' }];
    const refreshed = await app.inject({ method: 'GET', url: '/api/sessions/main/groups', headers });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toEqual(expect.arrayContaining([child, groups[0], { id: 'supplier@g.us', name: 'Bodega' }]));
    expect(refreshed.json()).toHaveLength(4);
    expect(db.prepare("SELECT target_group_ids FROM whatsapp_session_settings WHERE session_id='main'").get()).toEqual({ target_group_ids: JSON.stringify(targets) });
    expect((await app.inject({ method: 'PUT', url: '/api/sessions/main/targets', headers, payload: { targetGroupIds: targets } })).statusCode).toBe(200);
    await app.close();
  });

  it('creates more than nine providers and reads their stored groups without querying WhatsApp again', async () => {
    let groupQueries = 0;
    const groups = Array.from({ length: 12 }, (_, index) => ({ id: `supplier-${index}@g.us`, name: `Bodega ${index + 1}` }));
    const connector: WhatsAppConnector = {
      status: () => ({ status: 'connected', qr: null, lastError: null }), connect: async () => {}, disconnect: async () => {}, resetSession: async () => {},
      listGroups: async () => { groupQueries += 1; if (groupQueries > 1) throw new Error('rate-overlimit'); return groups; },
      sendImage: async () => ({ messageId: 'x' }),
    };
    const { app } = setup(connector);
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const initial = await app.inject({ method: 'GET', url: '/api/sessions/main/groups?cached=true', headers });
    expect(initial.json()).toHaveLength(12);
    for (const group of groups) {
      const created = await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers,
        payload: { name: group.name, sourceGroupId: group.id, priceMarginCop: 10000, boxMarginCop: 5000, markerText: '🌎⭐', defaultPosition: 'bottom_right' } });
      expect(created.statusCode, created.body).toBe(201);
      const cached = await app.inject({ method: 'GET', url: '/api/sessions/main/groups?cached=true', headers });
      expect(cached.statusCode).toBe(200);
      expect(cached.json()).toHaveLength(12);
    }
    const providers = await app.inject({ method: 'GET', url: '/api/sessions/main/providers', headers });
    expect(providers.json()).toHaveLength(12);
    expect(groupQueries).toBe(1);
    const explicitRefresh = await app.inject({ method: 'GET', url: '/api/sessions/main/groups', headers });
    expect(explicitRefresh.statusCode).toBe(503);
    expect(groupQueries).toBe(2);
    const cachedAfterError = await app.inject({ method: 'GET', url: '/api/sessions/main/groups?cached=true', headers });
    expect(cachedAfterError.json()).toHaveLength(12);
    await app.close();
  });

  it('reactivates an archived supplier group after nine active providers and preserves its historical product rules', async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const payload = { name: 'mbr', sourceGroupId: 'mbr@g.us', priceMarginCop: 0, boxMarginCop: 0, markerText: '🌎', defaultPosition: 'top_left' };
    for (let index = 0; index < 9; index++) {
      db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES (?,'main',?,?,10000,?,?)")
        .run(`active-${index}`, `active-${index}@g.us`, `Bodega ${index}`, now, now);
    }
    db.prepare("INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES ('main','mbr@g.us','BODEGA MBR PRECIOS',?)").run(now);
    const first = await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers, payload: { ...payload, priceMarginCop: 10000, boxMarginCop: 5000 } });
    expect(first.statusCode, first.body).toBe(201);
    const supplierId = first.json().id as string;
    const createdAt = (db.prepare('SELECT created_at FROM supplier_profiles WHERE id=?').get(supplierId) as { created_at: string }).created_at;
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,session_id,supplier_id,margin_cop_applied,box_margin_cop_applied,created_at,updated_at) VALUES ('historical-mbr','Tenis','PRECIO $60.000','{}','needs_review','main',?,10000,5000,?,?)")
      .run(supplierId, now, now);
    const archived = await app.inject({ method: 'DELETE', url: `/api/providers/${supplierId}`, headers: { host: headers.host } });
    expect(archived.statusCode).toBe(200);
    const before = await app.inject({ method: 'GET', url: '/api/sessions/main/providers', headers });
    expect(before.json()).toHaveLength(9);
    const secondary = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { name: 'Otra cuenta' } });
    const secondaryId = secondary.json().id as string;
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at,archived_at) VALUES ('secondary-mbr',?,'mbr@g.us','Otro proveedor',5000,?,?,?)")
      .run(secondaryId, now, now, now);

    const restored = await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers, payload });
    expect(restored.statusCode, restored.body).toBe(201);
    expect(restored.json()).toMatchObject({ id: supplierId, sessionId: 'main', ...payload });
    expect(db.prepare('SELECT archived_at,margin_cop,box_margin_cop,created_at FROM supplier_profiles WHERE id=?').get(supplierId))
      .toEqual({ archived_at: null, margin_cop: 0, box_margin_cop: 0, created_at: createdAt });
    expect(db.prepare("SELECT supplier_id,margin_cop_applied,box_margin_cop_applied FROM products WHERE id='historical-mbr'").get())
      .toEqual({ supplier_id: supplierId, margin_cop_applied: 10000, box_margin_cop_applied: 5000 });
    expect(db.prepare("SELECT name,margin_cop,archived_at FROM supplier_profiles WHERE id='secondary-mbr'").get())
      .toEqual({ name: 'Otro proveedor', margin_cop: 5000, archived_at: now });
    expect(db.prepare("SELECT action FROM audit_events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1").get(supplierId))
      .toEqual({ action: 'supplier.restored' });
    const after = await app.inject({ method: 'GET', url: '/api/sessions/main/providers', headers });
    expect(after.json()).toHaveLength(10);
    const duplicate = await app.inject({ method: 'POST', url: '/api/sessions/main/providers', headers, payload: { ...payload, priceMarginCop: 5000 } });
    expect(duplicate.statusCode).toBe(409);
    expect(db.prepare('SELECT margin_cop FROM supplier_profiles WHERE id=?').get(supplierId)).toEqual({ margin_cop: 0 });
    await app.close();
  });

  it.each(['create', 'restore', 'update'] as const)('does not misreport or partially save a supplier %s when the activity write fails', async (operation) => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
    const payload = { name: 'Proveedor nuevo', sourceGroupId: 'supplier@g.us', priceMarginCop: 0, boxMarginCop: 0, markerText: '🌎', defaultPosition: 'top_left' };
    db.prepare("INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES ('main','supplier@g.us','Proveedor',?)").run(now);
    if (operation !== 'create') {
      db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at,archived_at) VALUES ('supplier-test','main','supplier@g.us','Proveedor anterior',10000,?,?,?)")
        .run(now, now, operation === 'restore' ? now : null);
    }
    const before = db.prepare('SELECT * FROM supplier_profiles').all();
    db.exec("CREATE TRIGGER fail_supplier_activity BEFORE INSERT ON audit_events WHEN NEW.entity_type='supplier' BEGIN SELECT RAISE(ABORT,'Activity write failed'); END;");
    const response = await app.inject({ method: operation === 'update' ? 'PUT' : 'POST', url: operation === 'update' ? '/api/providers/supplier-test' : '/api/sessions/main/providers', headers, payload });
    expect(response.statusCode, response.body).toBe(500);
    expect(response.body).not.toContain('ya está registrado');
    expect(db.prepare('SELECT * FROM supplier_profiles').all()).toEqual(before);
    await app.close();
  });

  it('returns stored groups for an account without an active connector and rejects missing accounts', async () => {
    const { app, db } = setup();
    db.prepare("INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES ('main','stored@g.us','Bodega guardada',?)").run(new Date().toISOString());
    const headers = { host: '127.0.0.1:3210' };
    const stored = await app.inject({ method: 'GET', url: '/api/sessions/main/groups?cached=true', headers });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual([{ id: 'stored@g.us', name: 'Bodega guardada' }]);
    const missing = await app.inject({ method: 'GET', url: '/api/sessions/missing/groups?cached=true', headers });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('serves a marked image preview per source photo and preserves original bytes after code/position edits', async () => {
    const { app, db } = setup();
    const directory = temporaryDirectories.at(-1)!;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('supplier-preview','main','source@g.us','Bodega',10000,'🌎⭐','bottom_right',?,?)").run(now,now);
    const image = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 50, g: 70, b: 60 } } }).png().toBuffer();
    const hash = createHash('sha256').update(image).digest('hex');
    const fileName = `${hash}.png`;
    writeFileSync(join(directory,'media',fileName),image);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,marker_text_applied,image_position)
      VALUES ('preview-product','Tenis','HOMBRE COD 143 · 💲70.000','{}','needs_review',?,?,'main','supplier-preview',10000,'143','🌎⭐','bottom_right')`).run(now,now);
    const assetId = randomUUID();
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run(assetId,'preview-product',hash,fileName,'image/png',image.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete','[]',?)").run(assetId, now);

    const first = await app.inject({ method: 'GET', url: `/api/products/preview-product/preview?assetId=${assetId}`, headers: { host: '127.0.0.1:3210' } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('image/png');
    expect(await sharp(first.rawPayload).metadata()).toMatchObject({ width: 400, height: 300 });
    expect(first.rawPayload.equals(image)).toBe(false);
    const genderMarked = await renderMarkedImage(image, { code: '143', genderIndicator: 'H', marker: '🌎⭐', position: 'bottom_right' });
    expect(first.rawPayload).toEqual(genderMarked.bytes);

    const options = await app.inject({ method: 'PUT', url: '/api/products/preview-product/image-options', headers: { host: '127.0.0.1:3210','content-type': 'application/json' }, payload: { shoeCode: '001', position: 'top_left' } });
    expect(options.statusCode).toBe(200);
    const updated = await app.inject({ method: 'GET', url: `/api/products/preview-product/preview?assetId=${assetId}`, headers: { host: '127.0.0.1:3210' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.rawPayload.equals(first.rawPayload)).toBe(false);
    expect(readFileSync(join(directory,'media',fileName))).toEqual(image);
    await app.close();
  });
});


describe('manual corrections and approval of all products', () => {
  const headers = { host: '127.0.0.1:3210', 'content-type': 'application/json' };
  async function seed(db: ReturnType<typeof openDatabase>, id: string, status = 'needs_review', raw = 'COD 960\nPRECIO $60.000') {
    const now = new Date().toISOString();
    const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#cccccc' } }).png().toBuffer();
    const hash = createHash('sha256').update(image).digest('hex');
    writeFileSync(join(temporaryDirectories.at(-1)!, 'media', `${hash}.png`), image);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,margin_cop_applied,box_margin_cop_applied,shoe_code,marker_text_applied,image_position,source_price_cop,final_price_cop,output_text)
      VALUES (?,?,?,'{}',?,?,?,'main',10000,5000,'960','🌎','bottom_right',60000,70000,?)`).run(id, id, raw, status, now, now, status === 'needs_review' ? null : '*COD 960*\n*PRECIO $70.000*');
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run(`${id}-photo`, id, hash, `${hash}.png`, 'image/png', image.length, now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run(`${id}-photo`, JSON.stringify([{ corner: 'top_left', text: '960 🌎', code: '960', hasWorld: true, worldUncertain: false }]), now);
    return image;
  }

  it('lets every manual choice replace a ready false positive and restores automatic detection', async () => {
    const { app, db } = setup();
    const original = await seed(db, 'false-positive', 'approved');
    for (const mode of ['mark_code', 'mark_world', 'mark_all', 'original'] as const) {
      const result = await app.inject({ method: 'PUT', url: '/api/products/false-positive/images/false-positive-photo/marking', headers, payload: { mode } });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().marking).toMatchObject({ status: 'ready', mode, manual: true });
      const preview = await app.inject({ method: 'GET', url: '/api/products/false-positive/preview', headers });
      const expected = await renderMarkedImage(original, { code: '960', marker: '🌎', position: 'bottom_right', sourceCode: ['original', 'mark_world'].includes(mode) ? '960' : null, sourceHasWorld: ['original', 'mark_code'].includes(mode) });
      expect(preview.rawPayload).toEqual(expected.bytes);
    }
    const restored = await app.inject({ method: 'PUT', url: '/api/products/false-positive/images/false-positive-photo/marking', headers, payload: { mode: 'automatic' } });
    expect(restored.json().marking).toMatchObject({ status: 'ready', mode: 'original', manual: false });
    await app.close();
  });

  it('keeps manual choices across code, corner, corrupted OCR and reinspection, including failures', async () => {
    const inspection: ImageInspection = { ocrText: '', ocrConfidence: 0, ocrError: 'OCR falló', codeCandidates: [], detectedCode: null, detectedCodeConfidence: 0, world: { detected: false, variant: null, confidence: 0, bounds: null }, regions: [] };
    const { app, db } = setup(undefined, { inspect: async () => inspection });
    await seed(db, 'manual');
    const path = '/api/products/manual/images/manual-photo/marking';
    await app.inject({ method: 'PUT', url: path, headers, payload: { mode: 'mark_code' } });
    db.prepare("UPDATE image_marking_state SET regions_json='broken JSON' WHERE media_asset_id='manual-photo'").run();
    const options = await app.inject({ method: 'PUT', url: '/api/products/manual/image-options', headers, payload: { shoeCode: '123', position: 'top_right' } });
    expect(options.statusCode).toBe(200);
    let catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].marking).toMatchObject({ mode: 'mark_code', manual: true, status: 'ready' });
    await app.inject({ method: 'POST', url: '/api/products/manual/inspect-image', headers });
    catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].marking).toMatchObject({ mode: 'mark_code', manual: true, status: 'ready' });
    await app.inject({ method: 'PUT', url: '/api/products/manual/image-options', headers, payload: { shoeCode: null, position: 'top_right' } });
    catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    expect(catalog.json()[0].images[0].marking.status).toBe('review');
    for (const mode of ['mark_code', 'mark_all']) {
      expect((await app.inject({ method: 'PUT', url: path, headers, payload: { mode } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url: path, headers, payload: { mode: 'mark_world' } })).statusCode).toBe(200);
    const auto = await app.inject({ method: 'PUT', url: path, headers, payload: { mode: 'automatic' } });
    expect(auto.json().marking).toMatchObject({ status: 'review', manual: false });
    await app.close();
  });

  it('edits approved descriptions, cleans combined dozen labels and preserves source and prices', async () => {
    const { app, db } = setup();
    await seed(db, 'editable', 'approved');
    const result = await app.inject({ method: 'PUT', url: '/api/products/editable/description', headers, payload: { outputText: 'Tenis corregido🔥\nPRECIO $70.000\nCAJA Y DOCENA $50.000\nventa por docenas' } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().outputText).toBe('*TENIS CORREGIDO*\n*PRECIO $70.000*');
    expect(db.prepare("SELECT raw_text,source_price_cop,final_price_cop FROM products WHERE id='editable'").get()).toEqual({ raw_text: 'COD 960\nPRECIO $60.000', source_price_cop: 60000, final_price_cop: 70000 });
    for (const outputText of ['PRECIO $80.000', 'sin precio', 'DOCENA $70.000', 'PRECIO $70.000\nCAJA $45.000', '']) {
      expect((await app.inject({ method: 'PUT', url: '/api/products/editable/description', headers, payload: { outputText } })).statusCode).toBe(400);
    }
    expect(db.prepare("SELECT output_text FROM products WHERE id='editable'").get()).toEqual({ output_text: '*TENIS CORREGIDO*\n*PRECIO $70.000*' });
    await app.close();
  });

  it.each(['queued', 'in_progress', 'submitted', 'needs_review'])('locks description and photo decisions for %s publications', async (status) => {
    const { app, db } = setup();
    await seed(db, 'locked', 'approved');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO outbound_publications(id,product_id,group_id,group_name,generation,status,created_at,updated_at,session_id) VALUES ('locked-pub','locked','target@g.us','Target',1,?,?,?,'main')").run(status, now, now);
    expect((await app.inject({ method: 'PUT', url: '/api/products/locked/description', headers, payload: { outputText: 'PRECIO $70.000' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/api/products/locked/images/locked-photo/marking', headers, payload: { mode: 'original' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'main', products: [{ id: 'locked', reviewMode: 'original' }] } })).statusCode).toBe(409);
    await app.close();
  });

  it('approves ambiguous prices and every pending, failed or conflicting photo without sending', async () => {
    const { app, db } = setup();
    await seed(db, 'ambiguous', 'needs_review', 'COD 960\nAntes $80.000, PRECIO $60.000\nCAJA Y DOCENA $40.000');
    await seed(db, 'pending');
    await seed(db, 'failed', 'approved');
    db.prepare("UPDATE image_marking_state SET status='pending' WHERE media_asset_id='pending-photo'").run();
    db.prepare("UPDATE image_marking_state SET status='failed',error='OCR',regions_json='[]' WHERE media_asset_id='failed-photo'").run();
    db.prepare("UPDATE image_marking_state SET regions_json=? WHERE media_asset_id='ambiguous-photo'").run(JSON.stringify([{ corner: 'top_left', text: '999 🌎', code: '999', hasWorld: true, worldUncertain: false }]));
    const response = await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'main', products: [
      { id: 'ambiguous', sourcePricesCop: [80000, 60000], outputText: 'COD 960\nAntes $90.000, PRECIO $70.000\nCAJA Y DOCENA $40.000', reviewMode: 'mark_all' },
      { id: 'pending', sourcePricesCop: [60000], outputText: 'PRECIO $70.000', reviewMode: 'mark_code' },
      { id: 'failed', reviewMode: 'original' },
    ] } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ productCount: 3, approvedCount: 2, resolvedImages: 3 });
    const catalog = await app.inject({ method: 'GET', url: '/api/products', headers });
    for (const product of catalog.json()) {
      expect(product.status).toBe('approved');
      expect(product.images[0].marking).toMatchObject({ status: 'ready', manual: true });
      expect(product.output_text.toLowerCase()).not.toContain('docena');
    }
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications').get()).toEqual({ count: 0 });
    await app.close();
  });

  it('validates the entire bulk approval before writing and rejects duplicate or foreign products', async () => {
    const { app, db } = setup();
    await seed(db, 'valid');
    await seed(db, 'incomplete');
    const valid = { id: 'valid', sourcePricesCop: [60000], outputText: 'PRECIO $70.000', reviewMode: 'mark_all' };
    let result = await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'main', products: [valid, { id: 'incomplete', reviewMode: 'original' }] } });
    expect(result.statusCode).toBe(409);
    expect(db.prepare("SELECT status FROM products WHERE id='valid'").get()).toEqual({ status: 'needs_review' });
    result = await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'other-account', products: [valid] } });
    expect(result.statusCode).toBe(409);
    result = await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'main', products: [valid, valid] } });
    expect(result.statusCode).toBe(400);
    db.prepare("UPDATE products SET shoe_code=NULL,shoe_code_override=1 WHERE id='incomplete'").run();
    db.prepare("UPDATE image_marking_state SET status='failed' WHERE media_asset_id='incomplete-photo'").run();
    result = await app.inject({ method: 'POST', url: '/api/products/approve-all', headers, payload: { sessionId: 'main', products: [{ ...valid, id: 'incomplete' }] } });
    expect(result.statusCode).toBe(409);
    await app.close();
  });
});
