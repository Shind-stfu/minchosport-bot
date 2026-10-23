import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDatabase } from './database.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('multi-account schema migration', () => {
  it('builds history anchors from the latest original inbox timestamp while keeping a saved 5–8 p.m. range', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-history-anchors-migration-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const [index, sql] of MIGRATIONS.slice(0, 18).entries()) {
      legacy.transaction(() => {
        legacy.exec(sql);
        legacy.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)')
          .run(index + 1, createHash('sha256').update(sql).digest('hex'), new Date().toISOString());
      })();
    }
    const now = new Date().toISOString();
    legacy.prepare("UPDATE whatsapp_session_settings SET reception_start_time='17:00',reception_end_time='20:00' WHERE session_id='main'").run();
    const insert = legacy.prepare("INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,participant_jid,message_timestamp_ms,status,received_at) VALUES ('main','provider@g.us',?,'vendor@s.whatsapp.net',?,'processed',?)");
    insert.run('latest', Date.parse('2026-10-22T20:10:00-05:00'), now);
    insert.run('older', Date.parse('2026-10-22T17:10:00-05:00'), now);
    legacy.close();
    const db = openDatabase(path);
    expect(db.prepare('SELECT message_id,message_timestamp_ms,from_me,participant_jid FROM whatsapp_history_anchors').all()).toEqual([
      { message_id: 'latest', message_timestamp_ms: Date.parse('2026-10-22T20:10:00-05:00'), from_me: 0, participant_jid: 'vendor@s.whatsapp.net' },
    ]);
    expect(db.prepare("SELECT reception_start_time,reception_end_time FROM whatsapp_session_settings WHERE session_id='main'").get()).toEqual({ reception_start_time: '17:00', reception_end_time: '20:00' });
    expect(db.prepare('SELECT COUNT(*) as count FROM supplier_inbox_messages').get()).toEqual({ count: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades the old reception queue without changing a custom recovery range or importing its old pending messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-recovery-migration-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const [index, sql] of MIGRATIONS.slice(0, 17).entries()) {
      legacy.transaction(() => {
        legacy.exec(sql);
        legacy.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)')
          .run(index + 1, createHash('sha256').update(sql).digest('hex'), new Date().toISOString());
      })();
    }
    const now = new Date().toISOString();
    legacy.prepare("UPDATE whatsapp_session_settings SET reception_start_time='16:00',reception_end_time='18:00' WHERE session_id='main'").run();
    legacy.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Otra cuenta',?)").run(now);
    legacy.prepare("INSERT INTO whatsapp_session_settings(session_id,updated_at) VALUES ('secondary',?)").run(now);
    legacy.prepare("INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,message_timestamp_ms,status,received_at) VALUES ('main','provider@g.us','legacy-pending',1,'pending',?)").run(now);
    legacy.close();
    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT session_id,reception_start_time,reception_end_time FROM whatsapp_session_settings ORDER BY session_id').all()).toEqual([
      { session_id: 'main', reception_start_time: '16:00', reception_end_time: '18:00' },
      { session_id: 'secondary', reception_start_time: '16:00', reception_end_time: '19:00' },
    ]);
    expect(upgraded.prepare("SELECT status,reception_mode FROM supplier_inbox_messages WHERE message_id='legacy-pending'").get()).toEqual({ status: 'pending', reception_mode: 'recovery' });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });

  it('upgrades the released version 9 schema with OCR records and per-account pacing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-migration-v9-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const legacy = new Database(path);
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const [index, sql] of MIGRATIONS.slice(0, 9).entries()) {
      legacy.transaction(() => {
        legacy.exec(sql);
        legacy.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)')
          .run(index + 1, createHash('sha256').update(sql).digest('hex'), new Date().toISOString());
      })();
    }
    legacy.prepare('UPDATE schema_migrations SET checksum=? WHERE version=9')
      .run('5d98f4041e780ec21ffefd5f24596f056e6228e355ee58688298e714d7bf0923');
    legacy.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT MAX(version) as version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(upgraded.prepare("SELECT send_interval_ms FROM whatsapp_session_settings WHERE session_id='main'").get()).toEqual({ send_interval_ms: 10000 });
    expect((upgraded.pragma('table_info(image_inspections)') as Array<{ name: string }>).map((column) => column.name)).toContain('ocr_confidence');
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_brand_inspections','product_image_analysis')").all()).toEqual([]);
    expect(upgraded.prepare("SELECT last_send_at FROM session_distribution_control WHERE session_id='main'").get()).toEqual({ last_send_at: null });
    expect(upgraded.prepare('SELECT margin_cop,box_margin_cop FROM supplier_profiles').all()).toEqual([]);
    upgraded.close();
  });

  it('opens a database created with the earlier published checksum for migration 9 without changing its data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-migration-checksum-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const initial = openDatabase(path);
    initial.prepare(`INSERT INTO application_logs(id,session_id,level,category,action,entity_type,entity_id,message,details_json,created_at)
      VALUES ('existing-log','main','info','settings','whatsapp.connected','whatsapp','main','Connected','{}',?)`).run(new Date().toISOString());
    initial.close();

    const historical = new Database(path);
    historical.prepare('UPDATE schema_migrations SET checksum=? WHERE version=9')
      .run('5d98f4041e780ec21ffefd5f24596f056e6228e355ee58688298e714d7bf0923');
    historical.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT id,action,message FROM application_logs WHERE id=\'existing-log\'').get())
      .toEqual({ id: 'existing-log', action: 'whatsapp.connected', message: 'Connected' });
    expect(reopened.prepare('SELECT COUNT(*) as count FROM whatsapp_sessions').get()).toEqual({ count: 1 });
    reopened.close();
  });

  it('upgrades an installation that already applied visual-brand migrations without losing its catalog or session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-migration-v14-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const legacy = new Database(path);
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const [index, sql] of MIGRATIONS.slice(0, 14).entries()) {
      legacy.transaction(() => {
        legacy.exec(sql);
        legacy.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)')
          .run(index + 1, createHash('sha256').update(sql).digest('hex'), new Date().toISOString());
      })();
    }
    const now = new Date().toISOString();
    legacy.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('existing-tenis','Tenis','*MUJER 096-215*','{}','needs_review',?,?,'main')").run(now, now);
    legacy.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT MAX(version) as version FROM schema_migrations').get()).toEqual({ version: 19 });
    expect(upgraded.prepare("SELECT id,raw_text FROM products WHERE id='existing-tenis'").get())
      .toEqual({ id: 'existing-tenis', raw_text: '*MUJER 096-215*' });
    expect(upgraded.prepare("SELECT name FROM whatsapp_sessions WHERE id='main'").get()).toEqual({ name: 'Cuenta principal' });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_brand_inspections','product_image_analysis')").all()).toEqual([]);
    upgraded.close();
  });

  it('upgrades the existing single-account database without losing groups, provider, products, photos, queue, or auth', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-migration-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const legacy = new Database(path);
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const [index, sql] of MIGRATIONS.slice(0, 7).entries()) {
      legacy.transaction(() => {
        legacy.exec(sql);
        legacy.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)').run(index + 1, createHash('sha256').update(sql).digest('hex'), new Date().toISOString());
      })();
    }
    const now = new Date().toISOString();
    legacy.prepare("INSERT INTO settings(id,margin_cop,target_groups,updated_at) VALUES (1,5000,'[]',?)").run(now);
    legacy.prepare("UPDATE whatsapp_settings SET source_group_id='provider@g.us',target_group_ids='[\"destination@g.us\"]',updated_at=? WHERE id=1").run(now);
    legacy.prepare('INSERT INTO whatsapp_groups(jid,subject,updated_at) VALUES (?,?,?)').run('provider@g.us','Bodega uno',now);
    legacy.prepare('INSERT INTO whatsapp_groups(jid,subject,updated_at) VALUES (?,?,?)').run('destination@g.us','Clientes',now);
    legacy.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at) VALUES ('product-1','Tenis','Precio $60.000','{}','approved',?,?)").run(now,now);
    legacy.prepare("INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES ('image-1','product-1','hash-1','hash-1.png','image/png',8,0,?)").run(now);
    mkdirSync(join(directory,'media'),{recursive:true});
    writeFileSync(join(directory,'media','hash-1.png'),Buffer.from('original'));
    legacy.prepare("INSERT INTO whatsapp_source_messages(group_jid,message_id,participant_jid,product_id,received_at) VALUES ('provider@g.us','message-1','vendor@s.whatsapp.net','product-1',?)").run(now);
    legacy.prepare("INSERT INTO whatsapp_product_assemblies(product_id,group_jid,participant_jid,last_message_at,media_count,expected_media_count,status,association_confident) VALUES ('product-1','provider@g.us','vendor@s.whatsapp.net',?,1,1,'closed',1)").run(now);
    legacy.prepare("INSERT INTO outbound_publications(id,product_id,group_id,group_name,generation,status,created_at,updated_at) VALUES ('publication-1','product-1','destination@g.us','Clientes',1,'submitted',?,?)").run(now,now);
    legacy.prepare("INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,remote_message_id,completed_at) VALUES ('unit-1','publication-1',0,'image-1','submitted','wa-message-1',?)").run(now);
    legacy.prepare("INSERT INTO whatsapp_auth_meta(name,value) VALUES ('data_key_protected','protected-key')").run();
    legacy.prepare("INSERT INTO whatsapp_auth_records(record_type,record_id,ciphertext) VALUES ('creds','main','encrypted-creds')").run();
    legacy.prepare("INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES ('legacy-log-1','product.approved','product','product-1','{\"finalPriceCop\":70000}',?)").run(now);
    legacy.close();

    const db = openDatabase(path);
    expect(db.prepare('SELECT id,name FROM whatsapp_sessions').get()).toEqual({ id: 'main', name: 'Cuenta principal' });
    expect(db.prepare('SELECT session_id,jid,subject FROM whatsapp_groups ORDER BY jid').all()).toEqual([
      { session_id: 'main', jid: 'destination@g.us', subject: 'Clientes' }, { session_id: 'main', jid: 'provider@g.us', subject: 'Bodega uno' },
    ]);
    expect(db.prepare('SELECT id,session_id,supplier_id,margin_cop_applied,box_margin_cop_applied FROM products').get()).toMatchObject({ id: 'product-1', session_id: 'main', supplier_id: 'supplier-main', margin_cop_applied: 5000, box_margin_cop_applied: 5000 });
    expect(db.prepare('SELECT margin_cop,box_margin_cop FROM supplier_profiles WHERE id=\'supplier-main\'').get()).toEqual({ margin_cop: 5000, box_margin_cop: 5000 });
    expect(db.prepare('SELECT session_id,group_jid,message_id FROM whatsapp_source_messages').get()).toEqual({ session_id: 'main', group_jid: 'provider@g.us', message_id: 'message-1' });
    expect(db.prepare('SELECT session_id,group_id,status FROM outbound_publications').get()).toEqual({ session_id: 'main', group_id: 'destination@g.us', status: 'submitted' });
    expect(db.prepare('SELECT session_id,record_type,record_id,ciphertext FROM whatsapp_auth_records').get()).toEqual({ session_id: 'main', record_type: 'creds', record_id: 'main', ciphertext: 'encrypted-creds' });
    expect(db.prepare('SELECT session_id,action,level,details_json FROM application_logs WHERE id=\'legacy-log-1\'').get()).toEqual({ session_id: 'main', action: 'product.approved', level: 'info', details_json: '{"finalPriceCop":70000}' });
    expect(db.prepare("SELECT reception_start_time,reception_end_time,reception_timezone FROM whatsapp_session_settings WHERE session_id='main'").get()).toEqual({ reception_start_time: '16:00', reception_end_time: '19:00', reception_timezone: 'America/Bogota' });
    expect((db.pragma('foreign_key_list(whatsapp_source_messages)') as Array<{ table: string }>).some((foreignKey) => foreignKey.table === 'products')).toBe(false);
    expect(readFileSync(join(directory, 'media', 'hash-1.png'))).toEqual(Buffer.from('original'));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('keeps the source-message deduplication ledger when its product is deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-source-ledger-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('dedup-product','Tenis','Precio $60.000','{}','needs_review',?,?,'main')").run(now, now);
    db.prepare("INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,participant_jid,product_id,received_at) VALUES ('main','provider@g.us','message-kept','vendor@s.whatsapp.net','dedup-product',?)").run(now);
    db.prepare("INSERT INTO supplier_inbox_messages(session_id,group_jid,message_id,message_timestamp_ms,text,status,received_at) VALUES ('main','provider@g.us','pending-message',1,'Tenis','pending',?)").run(now);
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('secondary','Secundaria',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('secondary','[]',?)").run(now);
    expect(db.prepare("SELECT reception_start_time,reception_end_time FROM whatsapp_session_settings WHERE session_id='secondary'").get()).toEqual({ reception_start_time: '16:00', reception_end_time: '19:00' });
    expect(db.prepare("SELECT session_id FROM supplier_reception_state WHERE session_id='secondary'").get()).toEqual({ session_id: 'secondary' });
    db.prepare("DELETE FROM products WHERE id='dedup-product'").run();
    expect(db.prepare("SELECT product_id FROM whatsapp_source_messages WHERE message_id='message-kept'").get()).toEqual({ product_id: 'dedup-product' });
    expect(db.prepare("SELECT status FROM supplier_inbox_messages WHERE message_id='pending-message'").get()).toEqual({ status: 'pending' });
    db.close();
  });
});
