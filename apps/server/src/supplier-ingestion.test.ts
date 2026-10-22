import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-ingestion-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'business.sqlite'));
  const logger = Fastify({ logger: false }).log;
  db.prepare("INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES ('main','supplier@g.us','Proveedor',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('supplier-test','main','supplier@g.us','Proveedor',10000,'🌎⭐','bottom_right',?,?)").run(new Date().toISOString(),new Date().toISOString());
  return { directory, db, ingestion: new SupplierIngestionService(db, directory, logger) };
}

describe('supplier WhatsApp ingestion', () => {
  it('stores a numeric hyphen shoe code that follows MUJER in the supplier caption', async () => {
    const { db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    await ingestion.receive({
      groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'jordan-015-81',
      timestampMs: Date.parse('2026-01-01T12:00:00.000Z'),
      text: '*JORDAN ROSADA GRIS NEGRO* *MUJER 015-81* *$70.000* *RECARGA 🔥🔥🔥*',
      image: { bytes: png, mimeType: 'image/png' },
    });

    expect(db.prepare('SELECT shoe_code FROM products').get()).toEqual({ shoe_code: '015-81' });
    db.close();
  });

  it('stores MUJER 096-215 as the code of a received product without dropping its leading zero', async () => {
    const { db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'woman-096-215',
      timestampMs: Date.now(), text: '*MUJER 096-215*\nPRECIO $70.000', image: { bytes: png, mimeType: 'image/png' } });
    expect(db.prepare('SELECT shoe_code,raw_text FROM products').get()).toEqual({
      shoe_code: '096-215', raw_text: '*MUJER 096-215*\nPRECIO $70.000',
    });
    db.close();
  });

  it('stores the code after HOMBRE and an emoji in the supplier caption', async () => {
    const { db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'bape-174-54',
      timestampMs: Date.now(), text: '*BAPE FLIP STA CAFE BEIGE*\n*HOMBRE 🕴️174-54*\n*$100.000*NUEVO*🔥🔥', image: { bytes: png, mimeType: 'image/png' } });
    expect(db.prepare('SELECT shoe_code FROM products').get()).toEqual({ shoe_code: '174-54' });
    db.close();
  });

  it('stores every photo as an independent product, preserves originals, and ignores duplicate message ids', async () => {
    const { directory, db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const base = { groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', timestampMs: Date.parse('2026-01-01T12:00:00.000Z') };
    await ingestion.receive({ ...base, messageId: 'photo-1', text: 'Tenis deportivos\nTallas 36 a 40\nPrecio: $60.000', image: { bytes: png, mimeType: 'image/png', expectedAlbumImages: 2 } });
    await ingestion.receive({ ...base, messageId: 'photo-2', timestampMs: base.timestampMs + 800, text: '', image: { bytes: png, mimeType: 'image/png', expectedAlbumImages: 2 } });
    await ingestion.receive({ ...base, messageId: 'photo-2', timestampMs: base.timestampMs + 800, text: '', image: { bytes: png, mimeType: 'image/png', expectedAlbumImages: 2 } });
    await ingestion.receive({ ...base, groupId: 'buyers@g.us', messageId: 'not-supplier', text: 'Precio $90.000' });

    const products = db.prepare('SELECT id,title,raw_text,status FROM products').all() as Array<{ id: string; title: string; raw_text: string; status: string }>;
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ title: 'Tenis deportivos', status: 'needs_review' });
    expect(products[0]?.raw_text).toContain('Precio: $60.000');
    expect(db.prepare('SELECT COUNT(*) as count FROM whatsapp_source_messages').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) as count FROM application_logs WHERE session_id='main' AND action='product.received.whatsapp'").get()).toEqual({ count: 2 });
    const files = db.prepare('SELECT file_name FROM media_assets WHERE product_id=? ORDER BY position').all(products[0]!.id) as Array<{ file_name: string }>;
    expect(readFileSync(join(directory, 'media', files[0]!.file_name))).toEqual(png);
    expect(db.prepare('SELECT media_count,expected_media_count,status FROM whatsapp_product_assemblies WHERE product_id=?').get(products[0]!.id)).toEqual({ media_count: 1, expected_media_count: null, status: 'open' });
    db.close();
  });

  it('attaches a nearby description to an image-only message by the same supplier participant', async () => {
    const { db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const timestampMs = Date.parse('2026-01-01T12:00:00.000Z');
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'image-first', timestampMs, text: '', image: { bytes: png, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'description', timestampMs: timestampMs + 500, text: 'Tenis urbanos, tallas 37-41. Precio 60 mil.' });
    const row = db.prepare('SELECT raw_text,margin_cop_applied,box_margin_cop_applied,marker_text_applied,image_position FROM products').get() as { raw_text: string; margin_cop_applied: number; box_margin_cop_applied: number; marker_text_applied: string; image_position: string };
    expect(row.raw_text).toContain('Tenis urbanos');
    expect(row.raw_text).toContain('Precio 60 mil.');
    expect(row).toMatchObject({ margin_cop_applied: 10000, box_margin_cop_applied: 5000, marker_text_applied: '🌎⭐', image_position: 'bottom_right' });
    db.prepare("UPDATE supplier_profiles SET margin_cop=0,marker_text='🌍' WHERE id='supplier-test'").run();
    expect(db.prepare('SELECT margin_cop_applied,box_margin_cop_applied,marker_text_applied FROM products').get()).toEqual({ margin_cop_applied: 10000, box_margin_cop_applied: 5000, marker_text_applied: '🌎⭐' });
    expect(db.prepare('SELECT COUNT(*) as count FROM products').get()).toEqual({ count: 1 });
    db.close();
  });

  it('does not guess which photo belongs to a later description when several photos arrived', async () => {
    const { db, ingestion } = setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const timestampMs = Date.parse('2026-01-01T12:00:00.000Z');
    const base = { groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', timestampMs };
    await ingestion.receive({ ...base, messageId: 'bare-1', text: '', image: { bytes: png, mimeType: 'image/png' } });
    await ingestion.receive({ ...base, messageId: 'bare-2', timestampMs: timestampMs + 400, text: '', image: { bytes: png, mimeType: 'image/png' } });
    await ingestion.receive({ ...base, messageId: 'caption-later', timestampMs: timestampMs + 800, text: 'Tenis negros · 💲60.000' });
    const rows = db.prepare('SELECT raw_text,supplier_id FROM products ORDER BY created_at,id').all() as Array<{ raw_text: string; supplier_id: string | null }>;
    expect(rows.filter((row) => row.raw_text.trim())).toHaveLength(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.supplier_id).toBe('supplier-test');
    expect(db.prepare('SELECT COUNT(*) as count FROM media_assets').get()).toEqual({ count: 2 });
    db.close();
  });

  it('deduplicates by account, group, and message id instead of crossing account sessions', async () => {
    const { db, ingestion } = setup();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Cuenta secundaria',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('secondary','[]',?)").run(now);
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('secondary','stopped',?)").run(now);
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('supplier-secondary','secondary','supplier@g.us','Proveedor secundario',0,'🌍','top_left',?,?)").run(now,now);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
    const message = { groupId: 'supplier@g.us', messageId: 'same-message-id', participantId: 'vendor@s.whatsapp.net', timestampMs: Date.now(), text: 'Tenis $60.000', image: { bytes: png, mimeType: 'image/png' } };
    await ingestion.receive(message);
    await ingestion.receive({ ...message, sessionId: 'secondary' });
    expect(db.prepare('SELECT session_id,supplier_id FROM products ORDER BY session_id').all()).toEqual([
      { session_id: 'main', supplier_id: 'supplier-test' }, { session_id: 'secondary', supplier_id: 'supplier-secondary' },
    ]);
    expect(db.prepare('SELECT COUNT(*) as count FROM whatsapp_source_messages WHERE group_jid=? AND message_id=?').get('supplier@g.us','same-message-id')).toEqual({ count: 2 });
    db.close();
  });
});
