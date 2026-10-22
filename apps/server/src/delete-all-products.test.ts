import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './database.js';

const fixtures: Array<{ app: ReturnType<typeof createApp>; db: ReturnType<typeof openDatabase>; directory: string }> = [];
const headers = { host: '127.0.0.1:3210' };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-delete-all-'));
  const db = openDatabase(join(directory, 'business.sqlite'));
  const app = createApp({ db, dataDirectory: directory, logLevel: 'silent' });
  const now = new Date().toISOString();
  const insertProduct = db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id)
    VALUES (?,?,'COD 143','{}',?,?,?,?,?)`);
  const addProduct = (id: string, status = 'needs_review', sessionId = 'main', supplierId: string | null = null) => {
    insertProduct.run(id, id, status, now, now, sessionId, supplierId);
  };
  const addPhoto = (id: string, productId: string, fileName: string) => {
    db.prepare(`INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at)
      VALUES (?,?,?,?,'image/png',5,0,?)`).run(id, productId, fileName, fileName, now);
    writeFileSync(join(directory, 'media', fileName), 'photo');
  };
  const fixture = { app, db, directory, now, addProduct, addPhoto };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('delete all products in an account', () => {
  it('deletes more than 500 products of every state and provider without a confirmation payload, preserving other accounts and deduplication', async () => {
    const { app, db, directory, now, addProduct, addPhoto } = setup();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('other','Otra cuenta',?)").run(now);
    for (const id of ['supplier-a', 'supplier-b']) {
      db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
        VALUES (?,'main',?,?,10000,'🌎','bottom_right',?,?)`).run(id, `${id}@g.us`, id, now, now);
    }
    db.transaction(() => {
      for (let index = 0; index < 600; index++) {
        addProduct(`product-${index}`, ['needs_review', 'approved', 'simulated'][index % 3], 'main', index % 2 ? 'supplier-a' : 'supplier-b');
      }
    })();
    addProduct('other-product', 'needs_review', 'other');
    addPhoto('unique-photo', 'product-0', 'unique.png');
    addPhoto('shared-photo', 'product-1', 'shared.png');
    addPhoto('other-photo', 'other-product', 'shared.png');
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','product-0','buyers@g.us','Clientes','submitted',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id,rendered_file_name)
      VALUES ('unit','publication',0,'unique-photo','submitted','main','derived/render.png')`).run();
    mkdirSync(join(directory, 'media', 'derived'));
    writeFileSync(join(directory, 'media', 'derived', 'render.png'), 'render');
    db.prepare(`INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,product_id,received_at)
      VALUES ('main','supplier-a@g.us','received-message','product-0',?)`).run(now);

    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true, productCount: 600, imageCount: 2, deletedFiles: 2, fileErrors: 0 });
    expect(db.prepare('SELECT id FROM products').all()).toEqual([{ id: 'other-product' }]);
    expect(db.prepare('SELECT id FROM media_assets').all()).toEqual([{ id: 'other-photo' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_publications').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
    expect(existsSync(join(directory, 'media', 'unique.png'))).toBe(false);
    expect(existsSync(join(directory, 'media', 'derived', 'render.png'))).toBe(false);
    expect(existsSync(join(directory, 'media', 'shared.png'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM supplier_profiles').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT product_id FROM whatsapp_source_messages').get()).toEqual({ product_id: 'product-0' });
    expect(db.prepare("SELECT session_id,details_json FROM application_logs WHERE action='products.deleted.manually'").get())
      .toEqual({ session_id: 'main', details_json: JSON.stringify({ productCount: 600, imageCount: 2 }) });
  });

  it.each(['queued', 'in_progress', 'needs_review'])('rejects the entire deletion if a publication is %s', async (status) => {
    const { app, db, now, addProduct } = setup();
    addProduct('deletable');
    addProduct('blocked', 'approved');
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','blocked','buyers@g.us','Clientes',?,?,?,'main')`).run(status, now, now);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });
    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='products.deleted.manually'").get()).toEqual({ count: 0 });
  });

  it.each(['pending', 'transmitting', 'uncertain'])('also blocks a %s unit when its publication appears settled', async (status) => {
    const { app, db, now, addProduct, addPhoto } = setup();
    addProduct('blocked', 'approved');
    addPhoto('photo', 'blocked', 'photo.png');
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','blocked','buyers@g.us','Clientes','submitted',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id)
      VALUES ('unit','publication',0,'photo',?,'main')`).run(status);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });
    expect(response.statusCode).toBe(409);
    expect(db.prepare('SELECT id FROM products').get()).toEqual({ id: 'blocked' });
  });

  it('handles an empty catalog and refuses unknown or archived accounts', async () => {
    const { app, db, now } = setup();
    const empty = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ ok: true, productCount: 0, imageCount: 0, deletedFiles: 0, fileErrors: 0 });
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at,archived_at) VALUES ('archived','Archivada',?,?)").run(now, now);
    for (const id of ['missing', 'archived']) {
      const response = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/products`, headers });
      expect(response.statusCode).toBe(404);
    }
  });
});
