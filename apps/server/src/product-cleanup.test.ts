import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('catalog persistence across application restarts', () => {
  it('keeps products, original photos and confirmed publications when the local database is reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-catalog-restart-'));
    directories.push(directory);
    const path = join(directory, 'business.sqlite');
    const original = Buffer.from('original supplier photo');
    const now = new Date().toISOString();
    const db = openDatabase(path);
    mkdirSync(join(directory, 'media'), { recursive: true });
    writeFileSync(join(directory, 'media', 'restart-photo.png'), original);
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('restart-product','Tenis','COD 143','{}','approved',?,?,'main')").run(now, now);
    db.prepare("INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES ('restart-asset','restart-product','hash','restart-photo.png','image/png',?,0,?)").run(original.length, now);
    db.prepare("INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id) VALUES ('restart-publication','restart-product','buyers@g.us','Clientes','submitted',?,?,'main')").run(now, now);
    db.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT id,status FROM products').get()).toEqual({ id: 'restart-product', status: 'approved' });
    expect(reopened.prepare('SELECT id,status FROM outbound_publications').get()).toEqual({ id: 'restart-publication', status: 'submitted' });
    expect(reopened.prepare('SELECT COUNT(*) as count FROM whatsapp_source_messages').get()).toEqual({ count: 0 });
    expect(readFileSync(join(directory, 'media', 'restart-photo.png'))).toEqual(original);
    reopened.close();
  });
});
