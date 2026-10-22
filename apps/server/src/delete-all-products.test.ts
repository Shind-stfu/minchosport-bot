import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { OutboundDistributionService } from './outbound-distribution.js';
import type { WhatsAppConnector } from './whatsapp.js';
import pino from 'pino';
import sharp from 'sharp';
import { removeProducts } from './product-cleanup.js';

const fixtures: Array<{ app: ReturnType<typeof createApp>; db: ReturnType<typeof openDatabase>; directory: string }> = [];
const headers = { host: '127.0.0.1:3210' };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(send?: WhatsAppConnector['sendImage'], delay?: (ms: number) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-delete-all-'));
  const db = openDatabase(join(directory, 'business.sqlite'));
  const now = new Date().toISOString();
  const whatsapp: WhatsAppConnector = {
    status: () => ({ status: 'connected', qr: null, lastError: null }),
    connect: async () => {}, disconnect: async () => {}, resetSession: async () => {}, listGroups: async () => [],
    sendImage: send ?? (async () => { throw new Error('Unexpected test send'); }),
  };
  const distribution = send ? new OutboundDistributionService(db, directory, whatsapp, pino({ level: 'silent' }), true, 'main', delay) : undefined;
  const app = createApp({ db, dataDirectory: directory, logLevel: 'silent', ...(distribution ? { outboundDistribution: distribution, whatsapp, realSendsEnabled: true } : {}) });
  const insertProduct = db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id)
    VALUES (?,?,'COD 143','{}',?,?,?,?,?)`);
  const addProduct = (id: string, status = 'needs_review', sessionId = 'main', supplierId: string | null = null) => {
    insertProduct.run(id, id, status, now, now, sessionId, supplierId);
  };
  const addPhoto = (id: string, productId: string, fileName: string, bytes = Buffer.from('photo'), position = 0) => {
    db.prepare(`INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at)
      VALUES (?,?,?,?,'image/png',?,?,?)`).run(id, productId, fileName, fileName, bytes.length, position, now);
    writeFileSync(join(directory, 'media', fileName), bytes);
  };
  const addReadyProduct = async (id: string) => {
    addProduct(id, 'approved', 'main', 'supplier-live');
    db.prepare('UPDATE products SET output_text=? WHERE id=?').run('PRECIO $70.000', id);
    addPhoto(`${id}-photo`, id, `${id}.png`, await sharp({ create: { width: 640, height: 480, channels: 3, background: 'white' } }).png().toBuffer());
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,updated_at) VALUES (?,'complete','[]','original',?)").run(`${id}-photo`, now);
  };
  if (send) {
    db.prepare("UPDATE whatsapp_session_settings SET target_group_ids='[\"buyers-a@g.us\",\"buyers-b@g.us\"]' WHERE session_id='main'").run();
    db.prepare(`INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at)
      VALUES ('supplier-live','main','supplier@g.us','Proveedor',10000,'🌎','bottom_right',?,?)`).run(now, now);
  }
  const fixture = { app, db, directory, now, addProduct, addPhoto, addReadyProduct, distribution };
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
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('other','running',?)").run(now);
    db.prepare("UPDATE session_distribution_control SET status='running' WHERE session_id='main'").run();
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
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('other-publication','other-product','other-buyers@g.us','Otros clientes','queued',?,?,'other')`).run(now, now);
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
    expect(db.prepare('SELECT id,status FROM outbound_publications').all()).toEqual([{ id: 'other-publication', status: 'queued' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
    expect(existsSync(join(directory, 'media', 'unique.png'))).toBe(false);
    expect(existsSync(join(directory, 'media', 'derived', 'render.png'))).toBe(false);
    expect(existsSync(join(directory, 'media', 'shared.png'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM supplier_profiles').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT product_id FROM whatsapp_source_messages').get()).toEqual({ product_id: 'product-0' });
    expect(db.prepare('SELECT session_id,status FROM session_distribution_control ORDER BY session_id').all())
      .toEqual([{ session_id: 'main', status: 'stopped' }, { session_id: 'other', status: 'running' }]);
    expect(db.prepare("SELECT session_id,details_json FROM application_logs WHERE action='products.deleted.manually'").get())
      .toEqual({ session_id: 'main', details_json: JSON.stringify({ productCount: 600, imageCount: 2 }) });
  });

  it.each(['queued', 'in_progress', 'needs_review', 'submitted', 'failed', 'canceled'])('deletes every product even if a publication is %s', async (status) => {
    const { app, db, now, addProduct } = setup();
    addProduct('deletable');
    addProduct('blocked', 'approved');
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','blocked','buyers@g.us','Clientes',?,?,?,'main')`).run(status, now, now);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().productCount).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_publications').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='products.deleted.manually'").get()).toEqual({ count: 1 });
  });

  it.each(['pending', 'transmitting', 'uncertain', 'submitted', 'failed', 'canceled'])('also removes %s units and their photos', async (status) => {
    const { app, db, now, addProduct, addPhoto } = setup();
    addProduct('blocked', 'approved');
    addPhoto('photo', 'blocked', 'photo.png');
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','blocked','buyers@g.us','Clientes','submitted',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id)
      VALUES ('unit','publication',0,'photo',?,'main')`).run(status);
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_assets').get()).toEqual({ count: 0 });
  });

  it.each(['resolve', 'reject'] as const)('cancels a bulk send and queued calls without waiting for the connector, ignoring its late %s', async (outcome) => {
    const started = deferred<void>();
    const remote = deferred<{ messageId: string }>();
    let sends = 0;
    const { app, db, directory, distribution, addReadyProduct } = setup(async () => {
      sends += 1;
      if (sends === 1) { started.resolve(); return remote.promise; }
      return { messageId: `new-${sends}` };
    }, async () => {});
    await addReadyProduct('ready-a');
    await addReadyProduct('ready-b');
    const sending = app.inject({ method: 'POST', url: '/api/products/send-all', headers }).then((response) => response);
    expect(await Promise.race([started.promise.then(() => 'started'), sending.then((response) => response.body)])).toBe('started');
    const queued = distribution!.sendApprovedProduct('ready-b').catch((error: unknown) => error);

    const deleted = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });

    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().productCount).toBe(2);
    expect((await sending).statusCode).toBe(409);
    expect(await queued).toBeInstanceOf(Error);
    expect(sends).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
    expect(existsSync(join(directory, 'media', 'ready-a.png'))).toBe(false);
    expect(existsSync(join(directory, 'media', 'ready-b.png'))).toBe(false);
    expect(readdirSync(join(directory, 'media', 'derived'))).toEqual([]);
    if (outcome === 'resolve') remote.resolve({ messageId: 'late-result' });
    else remote.reject(new Error('Late connector failure'));
    await remote.promise.catch(() => {});
    expect(db.prepare("SELECT COUNT(*) AS count FROM application_logs WHERE action IN ('product.publication.submitted','product.publication.uncertain')").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_publications').get()).toEqual({ count: 0 });
    expect(distribution!.status()).toBe('stopped');
    await addReadyProduct('fresh');
    await distribution!.sendApprovedProduct('fresh');
    expect(sends).toBe(3);
  });

  it('interrupts the pacing delay so the next photo and remaining products never send', async () => {
    const pacing = deferred<void>();
    const continueDelay = deferred<void>();
    let sends = 0;
    const { app, db, addReadyProduct } = setup(async () => ({ messageId: `send-${++sends}` }), async () => {
      pacing.resolve();
      await continueDelay.promise;
    });
    await addReadyProduct('ready-a');
    await addReadyProduct('ready-b');
    const sending = app.inject({ method: 'POST', url: '/api/products/send-all', headers }).then((response) => response);
    expect(await Promise.race([pacing.promise.then(() => 'pacing'), sending.then((response) => response.body)])).toBe('pacing');

    const deleted = await app.inject({ method: 'DELETE', url: '/api/sessions/main/products', headers });

    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await sending).statusCode).toBe(409);
    continueDelay.resolve();
    await continueDelay.promise;
    expect(sends).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
  });

  it('waits for photo preparation to finish before cleaning its files and never starts a send', async () => {
    let sends = 0;
    const { db, directory, distribution, addReadyProduct } = setup(async () => ({ messageId: `unexpected-${++sends}` }));
    await addReadyProduct('preparing');
    const sending = distribution!.sendApprovedProduct('preparing').catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(existsSync(join(directory, 'media', 'derived'))).toBe(true);
    const result = await distribution!.cancelSendsAndRun(() => removeProducts(db, directory,
      [{ id: 'preparing', session_id: 'main', title: 'preparing' }], 'products.deleted.manually', 'Se eliminó el catálogo'));
    expect(await sending).toBeInstanceOf(Error);
    expect(result.productCount).toBe(1);
    expect(sends).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_publications').get()).toEqual({ count: 0 });
    expect(readdirSync(join(directory, 'media', 'derived'))).toEqual([]);
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

describe('delete selected photos', () => {
  const requestPhotos = (app: ReturnType<typeof createApp>, imageIds: string[]) => app.inject({
    method: 'DELETE', url: '/api/sessions/main/photos', headers, payload: { imageIds },
  });

  it('deletes a single photo from a reference, then removes its empty reference while retaining shared files', async () => {
    const { app, db, directory, now, addProduct, addPhoto } = setup();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('other','Otra cuenta',?)").run(now);
    addProduct('multi'); addProduct('other', 'needs_review', 'other');
    addPhoto('first', 'multi', 'unique.png');
    addPhoto('second', 'multi', 'shared.png', Buffer.from('photo'), 1);
    addPhoto('other-photo', 'other', 'shared.png');
    db.prepare("INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,product_id,received_at) VALUES ('main','source@g.us','message','multi',?)").run(now);
    let response = await requestPhotos(app, ['first']);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true, productCount: 0, imageCount: 1, deletedFiles: 1, fileErrors: 0 });
    expect(db.prepare("SELECT id FROM media_assets WHERE product_id='multi'").all()).toEqual([{ id: 'second' }]);
    expect(db.prepare("SELECT title,raw_text FROM products WHERE id='multi'").get()).toEqual({ title: 'multi', raw_text: 'COD 143' });
    expect(existsSync(join(directory, 'media', 'unique.png'))).toBe(false);
    response = await requestPhotos(app, ['second']);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ productCount: 1, imageCount: 1, deletedFiles: 0 });
    expect(db.prepare('SELECT id FROM products').all()).toEqual([{ id: 'other' }]);
    expect(existsSync(join(directory, 'media', 'shared.png'))).toBe(true);
    expect(db.prepare('SELECT product_id FROM whatsapp_source_messages').get()).toEqual({ product_id: 'multi' });
    expect(db.prepare("SELECT COUNT(*) as count FROM application_logs WHERE action='products.images.deleted.manually'").get()).toEqual({ count: 2 });
  });

  it('deletes selected photos in every publication/unit state and retains an unselected reference', async () => {
    const { app, db, now, addProduct, addPhoto } = setup();
    const imageIds: string[] = [];
    for (const [index, state] of ['pending', 'transmitting', 'uncertain', 'submitted', 'failed', 'canceled'].entries()) {
      const id = `state-${index}`;
      addProduct(id); addPhoto(`${id}-photo`, id, `${id}.png`); imageIds.push(`${id}-photo`);
      const publicationState = ['queued', 'in_progress', 'needs_review', 'submitted', 'failed', 'canceled'][index];
      db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
        VALUES (?,?,?,'Clientes',?,?,?,'main')`).run(id, id, `${id}@g.us`, publicationState, now, now);
      db.prepare('INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id) VALUES (?,?,0,?,?,\'main\')').run(id, id, `${id}-photo`, state);
    }
    addProduct('retained'); addPhoto('retained-photo', 'retained', 'retained.png');
    const response = await requestPhotos(app, imageIds);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ productCount: 6, imageCount: 6 });
    expect(db.prepare('SELECT id FROM products').all()).toEqual([{ id: 'retained' }]);
    expect(db.prepare('SELECT id FROM media_assets').all()).toEqual([{ id: 'retained-photo' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_units').get()).toEqual({ count: 0 });
  });

  it('supports a selection larger than a SQL batch without deleting remaining photos', async () => {
    const { app, db, addProduct, addPhoto } = setup();
    addProduct('large');
    const imageIds = Array.from({ length: 600 }, (_, index) => `photo-${index}`);
    for (const [index, id] of imageIds.entries()) addPhoto(id, 'large', 'batch.png', Buffer.from('photo'), index);
    addPhoto('keep', 'large', 'batch.png', Buffer.from('photo'), 600);
    const response = await requestPhotos(app, imageIds);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ productCount: 0, imageCount: 600, deletedFiles: 0 });
    expect(db.prepare('SELECT id FROM media_assets').all()).toEqual([{ id: 'keep' }]);
  });

  it.each([undefined, {}, { imageIds: [] }, { imageIds: ['valid', 'valid'] }, { imageIds: ['valid', 'missing'] }, { imageIds: ['valid', 'foreign'] }])('rejects invalid or foreign selections atomically: %j', async (payload) => {
    const { app, db, now, addProduct, addPhoto } = setup();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('other','Otra cuenta',?)").run(now);
    addProduct('valid-product'); addPhoto('valid', 'valid-product', 'valid.png');
    addProduct('foreign-product', 'needs_review', 'other'); addPhoto('foreign', 'foreign-product', 'foreign.png');
    const response = await app.inject({ method: 'DELETE', url: '/api/sessions/main/photos', headers, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_assets').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual({ count: 0 });
  });

  it('preserves the caption for the next pending photo and updates the reference assembly', async () => {
    const { app, db, now, addProduct, addPhoto } = setup();
    addProduct('multi', 'approved'); addPhoto('first', 'multi', 'first.png'); addPhoto('second', 'multi', 'second.png', Buffer.from('photo'), 1);
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','multi','buyers@g.us','Clientes','queued',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id,caption_snapshot)
      VALUES ('unit-first','publication',0,'first','pending','main','PRECIO $70.000'),('unit-second','publication',1,'second','pending','main','')`).run();
    db.prepare(`INSERT INTO whatsapp_product_assemblies(product_id,group_jid,participant_jid,last_message_at,media_count,expected_media_count,status,session_id)
      VALUES ('multi','source@g.us','vendor',?,2,2,'open','main')`).run(now);
    const response = await requestPhotos(app, ['first']);
    expect(response.statusCode, response.body).toBe(200);
    expect(db.prepare('SELECT id,caption_snapshot,status FROM outbound_units').all()).toEqual([{ id: 'unit-second', caption_snapshot: 'PRECIO $70.000', status: 'pending' }]);
    expect(db.prepare('SELECT status FROM outbound_publications').get()).toEqual({ status: 'queued' });
    expect(db.prepare('SELECT media_count,expected_media_count,status FROM whatsapp_product_assemblies').get()).toEqual({ media_count: 1, expected_media_count: null, status: 'closed' });
  });

  it('cancels the selected active reference while a bulk send continues with the unselected reference', async () => {
    const started = deferred<void>(); const remote = deferred<{ messageId: string }>();
    let calls = 0;
    const { app, db, addReadyProduct } = setup(async () => {
      calls += 1;
      if (calls === 1) { started.resolve(); return remote.promise; }
      return { messageId: `unselected-${calls}` };
    }, async () => {});
    await addReadyProduct('a-selected'); await addReadyProduct('b-retained');
    const sending = app.inject({ method: 'POST', url: '/api/products/send-all', headers }).then((response) => response);
    expect(await Promise.race([started.promise.then(() => 'started'), sending.then((response) => response.body)])).toBe('started');
    const deleted = await requestPhotos(app, ['a-selected-photo']);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await sending).json()).toMatchObject({ sentProducts: 1, skipped: 1 });
    expect(calls).toBe(3);
    remote.resolve({ messageId: 'late-result' }); await remote.promise;
    expect(db.prepare('SELECT id FROM products').all()).toEqual([{ id: 'b-retained' }]);
    expect(db.prepare('SELECT product_id,status FROM outbound_publications').all()).toEqual([
      { product_id: 'b-retained', status: 'submitted' }, { product_id: 'b-retained', status: 'submitted' },
    ]);
    expect(db.prepare("SELECT COUNT(*) as count FROM application_logs WHERE action='product.publication.submitted' AND entity_id='a-selected'").get()).toEqual({ count: 0 });
  });

  it('deletes a queued reference without waiting for an unrelated active send or letting later requests overtake it', async () => {
    const started = deferred<void>(); const remote = deferred<{ messageId: string }>(); let calls = 0;
    const { app, db, distribution, addReadyProduct } = setup(async () => {
      calls += 1; if (calls === 1) { started.resolve(); return remote.promise; }
      return { messageId: `send-${calls}` };
    }, async () => {});
    await addReadyProduct('active'); await addReadyProduct('queued'); await addReadyProduct('later');
    const active = distribution!.sendApprovedProduct('active');
    await started.promise;
    const queued = distribution!.sendApprovedProduct('queued').catch((error: unknown) => error);
    const deleted = await requestPhotos(app, ['queued-photo']);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await queued).toBeInstanceOf(Error);
    const later = distribution!.sendApprovedProduct('later');
    await Promise.resolve(); expect(calls).toBe(1);
    remote.resolve({ messageId: 'active-result' });
    await Promise.all([active, later]);
    expect(calls).toBe(4);
    expect(db.prepare('SELECT id FROM products ORDER BY id').all()).toEqual([{ id: 'active' }, { id: 'later' }]);
  });

  it('keeps a surviving in-flight photo uncertain when another photo of that reference is deleted', async () => {
    const started = deferred<void>(); const remote = deferred<{ messageId: string }>();
    const { app, db, now, distribution, addReadyProduct, addPhoto } = setup(async () => { started.resolve(); return remote.promise; });
    await addReadyProduct('multi'); addPhoto('remove', 'multi', 'remove.png', Buffer.from('photo'), 1);
    db.prepare(`INSERT INTO outbound_publications(id,product_id,group_id,group_name,status,created_at,updated_at,session_id)
      VALUES ('publication','multi','buyers@g.us','Clientes','queued',?,?,'main')`).run(now, now);
    db.prepare(`INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,session_id,caption_snapshot)
      VALUES ('first','publication',0,'multi-photo','pending','main','PRECIO $70.000'),('second','publication',1,'remove','pending','main','')`).run();
    const sending = distribution!.sendApprovedProduct('multi').catch((error: unknown) => error);
    await started.promise;
    const response = await requestPhotos(app, ['remove']);
    expect(response.statusCode, response.body).toBe(200);
    expect(await sending).toBeInstanceOf(Error);
    remote.resolve({ messageId: 'late' }); await remote.promise;
    expect(db.prepare('SELECT id,status FROM outbound_units').all()).toEqual([{ id: 'first', status: 'uncertain' }]);
    expect(db.prepare('SELECT status FROM outbound_publications').get()).toEqual({ status: 'needs_review' });
    await expect(distribution!.sendApprovedProduct('multi')).rejects.toThrow('incierto');
  });
});
