import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { OutboundDistributionService } from './outbound-distribution.js';
import { renderMarkedImage, saveMarkedImage } from './image-marking.js';
import type { WhatsAppConnector } from './whatsapp.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(send: WhatsAppConnector['sendImage'], enabled = true, delay: (ms: number) => Promise<void> = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-outbound-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'business.sqlite'));
  const logger = Fastify({ logger: false }).log;
  const whatsapp: WhatsAppConnector = {
    status: () => ({ status: 'connected', qr: null, lastError: null }),
    connect: async () => {}, disconnect: async () => {}, resetSession: async () => {}, listGroups: async () => [],
    sendImage: send,
  };
  db.prepare("UPDATE whatsapp_session_settings SET target_group_ids=? WHERE session_id='main'").run(JSON.stringify(['buyers-a@g.us', 'buyers-b@g.us']));
  db.prepare('INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?)').run('main','buyers-a@g.us', 'Clientes A', new Date().toISOString());
  db.prepare('INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?)').run('main','buyers-b@g.us', 'Clientes B', new Date().toISOString());
  db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('supplier-test','main','supplier@g.us','Proveedor',10000,'🌎⭐','bottom_right',?,?)").run(new Date().toISOString(),new Date().toISOString());
  const ingestion = new SupplierIngestionService(db, directory, logger);
  const distribution = new OutboundDistributionService(db, directory, whatsapp, logger, enabled, 'main', delay);
  return { db, directory, ingestion, distribution };
}
async function photo() { return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 110, b: 95 } } }).png().toBuffer(); }
function analyzedPhotos(db: ReturnType<typeof openDatabase>, productId?: string) {
  const ids = db.prepare(`SELECT m.id FROM media_assets m ${productId ? 'WHERE m.product_id=?' : ''}`).all(...(productId ? [productId] : [])) as Array<{ id: string }>;
  for (const { id } of ids) db.prepare("INSERT OR REPLACE INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete','[]',?)").run(id, new Date().toISOString());
}

describe('manual outbound distribution', () => {
  it('never publishes simulated products through the real WhatsApp connector', async () => {
    let sendCount = 0;
    const { db, distribution } = setup(async () => { sendCount += 1; return { messageId: 'must-not-send' }; });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,output_text,status,created_at,updated_at,session_id,supplier_id)
      VALUES ('simulation-only','Producto de prueba','Tenis $70.000','{}','Tenis $70.000','simulated',?,?,'main','supplier-test')`).run(now, now);

    await expect(distribution.sendApprovedProduct('simulation-only')).rejects.toThrow('Solo se pueden enviar productos aprobados');
    await expect(distribution.approveAndSendAll(undefined, ['simulation-only'])).resolves.toMatchObject({ sentProducts: 0, sentGroups: 0, sentImages: 0, skipped: 1 });
    expect(sendCount).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbound_publications').get()).toEqual({ count: 0 });

    await distribution.stop();
    db.close();
  });

  it.each(['individual', 'batch'] as const)('completes only the missing community destination through an explicit %s send', async (mode) => {
    const sent: string[] = [];
    const { db, ingestion, distribution } = setup(async (groupId) => { sent.push(groupId); return { messageId: `wa-${sent.length}` }; });
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'partial-photo', timestampMs: Date.now() - 20_000,
      text: 'COD 143 PRECIO $60.000', image: { bytes: await photo(), mimeType: 'image/png', expectedAlbumImages: 1 } });
    await distribution.processNow();
    analyzedPhotos(db);
    const { id } = db.prepare('SELECT id FROM products').get() as { id: string };
    await distribution.sendApprovedProduct(id);
    expect(sent).toEqual(['buyers-a@g.us', 'buyers-b@g.us']);
    const child = 'community-child@g.us';
    db.prepare("INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES ('main',?,?,?)").run(child, '#3 Mincho Sport STEFFA Mundo Zapatillas L302', new Date().toISOString());
    db.prepare("UPDATE whatsapp_session_settings SET target_group_ids=? WHERE session_id='main'").run(JSON.stringify(['buyers-a@g.us', 'buyers-b@g.us', child]));
    expect(sent).toHaveLength(2); // Saving a target alone must never send anything.
    if (mode === 'individual') expect(await distribution.sendApprovedProduct(id)).toEqual({ groupCount: 1, imageCount: 1 });
    else expect(await distribution.approveAndSendAll(undefined, [id])).toMatchObject({ sentProducts: 1, sentGroups: 1, sentImages: 1, skipped: 0 });
    expect(sent).toEqual(['buyers-a@g.us', 'buyers-b@g.us', child]);
    expect(db.prepare('SELECT group_id,status FROM outbound_publications ORDER BY group_id').all()).toEqual([
      { group_id: 'buyers-a@g.us', status: 'submitted' }, { group_id: 'buyers-b@g.us', status: 'submitted' }, { group_id: child, status: 'submitted' },
    ]);
    await expect(distribution.sendApprovedProduct(id)).rejects.toThrow('ya fue enviado');
    expect(await distribution.approveAndSendAll(undefined, [id])).toMatchObject({ sentProducts: 0, skipped: 1 });
    expect(sent).toHaveLength(3);
    await distribution.stop(); db.close();
  });

  it('waits at least the configured interval between photos across destination groups', async () => {
    const pauses: number[] = [];
    let sentCount = 0;
    const { db, directory, distribution } = setup(async () => ({ messageId: `paced-${++sentCount}` }), true, async (ms) => { pauses.push(ms); });
    db.prepare("UPDATE whatsapp_session_settings SET send_interval_ms=5000 WHERE session_id='main'").run();
    const image = await photo(); const hash = createHash('sha256').update(image).digest('hex'); const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), image);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied)
      VALUES (?,?,?,'{}',60000,70000,?,'approved',?,?,'main','supplier-test',10000)`).run(id,'Ráfaga de prueba','Tenis $70.000','Tenis $70.000',now,now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run(randomUUID(),id,hash,fileName,'image/png',image.length,now);

    analyzedPhotos(db, id);
    const result = await distribution.sendApprovedProduct(id);
    expect(result).toEqual({ groupCount: 2, imageCount: 2 });
    expect(sentCount).toBe(2);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeGreaterThanOrEqual(4900);
    expect(db.prepare("SELECT last_send_at FROM session_distribution_control WHERE session_id='main'").get()).toMatchObject({ last_send_at: expect.any(String) });
    await distribution.stop();
    db.close();
  });

  it('does not add duplicate code or world overlays when photo inspection found both already present', async () => {
    const sent: Buffer[] = [];
    const { db, directory, distribution } = setup(async (_groupId, bytes) => { sent.push(Buffer.from(bytes)); return { messageId: `no-duplicate-${sent.length}` }; });
    const image = await photo(); const hash = createHash('sha256').update(image).digest('hex'); const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), image);
    const id = randomUUID(); const assetId = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,marker_text_applied)
      VALUES (?,?,?,'{}',60000,70000,?,'approved',?,?,'main','supplier-test',10000,'960','🌎⭐')`).run(id,'Marca encontrada','Tenis $70.000','Tenis $70.000',now,now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run(assetId,id,hash,fileName,'image/png',image.length,now);
    db.prepare(`INSERT INTO image_inspections(media_asset_id,ocr_text,ocr_confidence,code_candidates_json,detected_code,code_confidence,world_variant,world_confidence,inspected_at)
      VALUES (?,?,0.95,?,NULL,0,'🌍',0.98,?)`).run(assetId,'960A ©',JSON.stringify([]),now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run(assetId, JSON.stringify([{ corner: 'top_left', text: '960A ©', code: null, hasWorld: true, worldUncertain: false }]), now);

    await distribution.sendApprovedProduct(id);
    expect(sent).toHaveLength(2);
    expect(sent.every((bytes) => bytes.equals(image))).toBe(true);
    expect(readFileSync(join(directory, 'media', fileName))).toEqual(image);
    await distribution.stop();
    db.close();
  });

  it('does not create publications when the photo code conflicts with the product code', async () => {
    let sends = 0;
    const { db, directory, distribution } = setup(async () => { sends += 1; return { messageId: 'must-not-send' }; });
    const image = await photo(); const hash = createHash('sha256').update(image).digest('hex'); const now = new Date().toISOString();
    writeFileSync(join(directory, 'media', `${hash}.png`), image);
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,marker_text_applied) VALUES ('conflict-photo','Tenis','COD 960 $70.000','{}','COD 960 $80.000','approved',?,?,'main','supplier-test',10000,'960','🌍')").run(now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run('conflict-asset','conflict-photo',hash,`${hash}.png`,'image/png',image.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run('conflict-asset', JSON.stringify([{ corner: 'top_left', text: '999 🌍', code: '999', hasWorld: true, worldUncertain: false }]), now);
    await expect(distribution.sendApprovedProduct('conflict-photo')).rejects.toThrow('999');
    expect(sends).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications').get()).toEqual({ count: 0 });
    await distribution.stop(); db.close();
  });

  it('marks an older approved photo with MUJER 096-215 even when its stored code was empty', async () => {
    const sent: Buffer[] = [];
    const { db, directory, distribution } = setup(async (_groupId, bytes) => {
      sent.push(Buffer.from(bytes)); return { messageId: `gender-code-${sent.length}` };
    });
    const image = await photo();
    const hash = createHash('sha256').update(image).digest('hex');
    const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), image);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,marker_text_applied)
      VALUES (?,?,'*MUJER 096-215*\nPRECIO $70.000','{}',70000,80000,'MUJER 096-215\nPRECIO $80.000','approved',?,?,'main','supplier-test',10000,'🌎⭐')`)
      .run(id, 'Tenis mujer', now, now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(randomUUID(), id, hash, fileName, 'image/png', image.length, now);
    analyzedPhotos(db, id);
    await distribution.sendApprovedProduct(id);
    const expected = await renderMarkedImage(image, { code: '096-215', genderIndicator: 'D', marker: '🌎⭐', position: 'bottom_right' });
    expect(sent).toHaveLength(2);
    expect(sent.every((bytes) => bytes.equals(expected.bytes))).toBe(true);
    expect(db.prepare('SELECT shoe_code FROM products WHERE id=?').get(id)).toEqual({ shoe_code: null });
    await distribution.stop(); db.close();
  });

  it('bulk approves clear supplier references and sends them while leaving ambiguous prices for review', async () => {
    const sent: string[] = [];
    const { db, ingestion, distribution } = setup(async (groupId) => { sent.push(groupId); return { messageId: `wa-${sent.length}` }; });
    const image = await photo();
    const timestamp = Date.now() - 30_000;
    const base = { groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', timestampMs: timestamp };
    await ingestion.receive({ ...base, messageId: 'bulk-clear-a', text: 'Tenis azul. Precio: $60.000', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await ingestion.receive({ ...base, messageId: 'bulk-ambiguous', timestampMs: timestamp + 5_000, text: 'Tenis rojo. Antes $80.000, hoy $60.000', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await ingestion.receive({ ...base, messageId: 'bulk-clear-b', timestampMs: timestamp + 10_000, text: 'Tenis blanco. Precio 60 mil', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });

    for (let i = 0; i < 4; i += 1) await distribution.processNow();
    analyzedPhotos(db);
    const result = await distribution.approveAndSendAll();

    expect(result).toMatchObject({ sentProducts: 2, sentGroups: 4, sentImages: 4, reviewRequired: 1, skipped: 0 });
    expect(sent).toHaveLength(4);
    expect(db.prepare("SELECT COUNT(*) as count FROM products WHERE status='needs_review'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_publications WHERE status='submitted'").get()).toEqual({ count: 4 });
    await distribution.stop();
    db.close();
  });

  it('sends only the explicitly selected prepared products from the current supplier account', async () => {
    const sentGroups: string[] = [];
    const { db, directory, distribution } = setup(async (groupId) => { sentGroups.push(groupId); return { messageId: `selected-${sentGroups.length}` }; });
    const image = await photo(); const hash = createHash('sha256').update(image).digest('hex'); const fileName = `${hash}.png`;
    writeFileSync(join(directory, 'media', fileName), image);
    const now = new Date().toISOString();
    const selectedId = randomUUID(); const otherId = randomUUID();
    const insertProduct = db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,marker_text_applied)
      VALUES (?,?,?,'{}',60000,70000,?,'approved',?,?,'main','supplier-test',10000,'🌎⭐')`);
    insertProduct.run(selectedId, 'Tenis seleccionado', 'COD 101 $70.000', 'COD 101 $70.000', now, now);
    insertProduct.run(otherId, 'Tenis fuera de selección', 'COD 102 $70.000', 'COD 102 $70.000', now, now);
    for (const id of [selectedId, otherId]) db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(randomUUID(), id, hash, fileName, 'image/png', image.length, now);
    analyzedPhotos(db);

    const result = await distribution.approveAndSendAll(undefined, [selectedId]);
    expect(result).toMatchObject({ sentProducts: 1, sentGroups: 2, sentImages: 2, skipped: 0 });
    expect(sentGroups).toEqual(['buyers-a@g.us', 'buyers-b@g.us']);
    expect(db.prepare('SELECT product_id FROM outbound_publications ORDER BY product_id').all()).toEqual([{ product_id: selectedId }, { product_id: selectedId }]);
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications WHERE product_id=?').get(otherId)).toEqual({ count: 0 });

    await distribution.stop();
    db.close();
  });

  it('prepares a clear supplier price and sends a marked photo with the adjusted description to each destination', async () => {
    const sent: Array<{ groupId: string; caption?: string; bytes: Buffer }> = [];
    const { db, directory, ingestion, distribution } = setup(async (groupId, bytes, _mime, caption) => {
      sent.push({ groupId, bytes: Buffer.from(bytes), ...(caption === undefined ? {} : { caption }) });
      return { messageId: `wa-${sent.length}` };
    });
    const image = await photo();
    const timestampMs = Date.now() - 20_000;
    const base = { groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', timestampMs };
    await ingestion.receive({ ...base, messageId: 'photo-a', text: 'Tenis 🔥urbanos\nTallas 36-40\nPrecio: $60.000👟', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 2 } });
    await ingestion.receive({ ...base, messageId: 'photo-b', timestampMs: timestampMs + 500, text: '', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 2 } });

    for (let i = 0; i < 4; i += 1) await distribution.processNow();

    const product = db.prepare('SELECT source_price_cop,final_price_cop,output_text,status FROM products').get() as { source_price_cop: number; final_price_cop: number; output_text: string; status: string };
    expect(product).toMatchObject({ source_price_cop: 60000, final_price_cop: 70000, status: 'approved' });
    expect(product.output_text).toContain('$70.000');
    expect(product.output_text).toBe('*TENIS URBANOS*\n*TALLAS 36-40*\n*PRECIO: $70.000*');
    expect(sent).toHaveLength(0);
    analyzedPhotos(db);
    const result = await distribution.sendApprovedProduct((db.prepare("SELECT id FROM products WHERE status='approved'").get() as { id: string }).id);
    expect(result).toEqual({ groupCount: 2, imageCount: 2 });
    expect(sent).toHaveLength(2);
    expect(sent.map(({ groupId }) => groupId).sort()).toEqual(['buyers-a@g.us', 'buyers-b@g.us']);
    expect(sent.filter((entry) => entry.caption).map((entry) => entry.caption)).toEqual([product.output_text, product.output_text]);
    expect(sent.every((entry) => !/\p{Extended_Pictographic}/u.test(entry.caption ?? ''))).toBe(true);
    const sourceAsset = db.prepare('SELECT file_name FROM media_assets WHERE product_id=?').get((db.prepare("SELECT id FROM products WHERE status='approved'").get() as { id: string }).id) as { file_name: string };
    expect(readFileSync(join(directory, 'media', sourceAsset.file_name))).toEqual(image);
    expect(sent.every((entry) => !entry.bytes.equals(image))).toBe(true);
    expect(await sharp(sent[0]!.bytes).metadata()).toMatchObject({ width: 640, height: 480 });
    expect(sent[0]!.bytes).toEqual(sent[1]!.bytes);
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_publications WHERE status='submitted'").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_units WHERE status='submitted'").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) as count FROM application_logs WHERE action='product.publication.submitted' AND session_id='main'").get()).toEqual({ count: 2 });
    await expect(distribution.sendApprovedProduct((db.prepare("SELECT id FROM products WHERE status='approved'").get() as { id: string }).id)).rejects.toThrow('ya fue enviado');
    expect(sent).toHaveLength(2);
    await distribution.stop();
    db.close();
  });

  it('automatically applies the PRECIO and CAJA margins independently and preserves zero-margin snapshots', async () => {
    const { db, ingestion, distribution } = setup(async () => ({ messageId: 'no-send' }), false);
    const image = await photo();
    const base = { groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', timestampMs: Date.now() - 30_000, image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } };
    const mixed = 'Vans dama\n*PRECIO $45.000*👟\n*CAJA $35.000📦*';
    await ingestion.receive({ ...base, messageId: 'vans-with-margin', text: mixed });
    await distribution.processNow();
    const first = db.prepare('SELECT raw_text,output_text,source_price_cop,final_price_cop,margin_cop_applied,box_margin_cop_applied,status FROM products WHERE raw_text=?').get(mixed) as Record<string, unknown>;
    expect(first).toMatchObject({ raw_text: mixed, output_text: '*VANS DAMA*\n*PRECIO $55.000*\n*CAJA $40.000*', source_price_cop: 45000, final_price_cop: 55000, margin_cop_applied: 10000, box_margin_cop_applied: 5000, status: 'approved' });

    db.prepare("UPDATE supplier_profiles SET margin_cop=0,box_margin_cop=0 WHERE id='supplier-test'").run();
    await ingestion.receive({ ...base, messageId: 'vans-already-adjusted', timestampMs: base.timestampMs + 10_000, text: mixed });
    await distribution.processNow();
    const second = db.prepare('SELECT output_text,source_price_cop,final_price_cop,margin_cop_applied,box_margin_cop_applied,status FROM products WHERE raw_text=? ORDER BY created_at DESC LIMIT 1').get(mixed) as Record<string, unknown>;
    expect(second).toMatchObject({ output_text: '*VANS DAMA*\n*PRECIO $45.000*\n*CAJA $35.000*', source_price_cop: 45000, final_price_cop: 45000, margin_cop_applied: 0, box_margin_cop_applied: 0, status: 'approved' });
    await distribution.stop();
    db.close();
  });

  it.each(['DOCENA', 'CAJA Y DOCENA', 'caja / docenas'])('excludes %s pricing from automatic outgoing captions', async (label) => {
    const { db, ingestion, distribution } = setup(async () => ({ messageId: 'no-send' }), false);
    db.prepare("UPDATE supplier_profiles SET margin_cop=0,box_margin_cop=5000 WHERE id='supplier-test'").run();
    const image = await photo();
    const text = `🦅REF 292 D🦅\nPRECIO $55.000👟\n${label} $50.000📦`;
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'docena-auto', timestampMs: Date.now() - 30_000, text, image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await distribution.processNow();
    const product = db.prepare('SELECT raw_text,output_text,source_price_cop,final_price_cop,status FROM products').get() as Record<string, unknown>;
    expect(product).toMatchObject({ raw_text: text, output_text: '*REF 292 D*\n*PRECIO $55.000*', source_price_cop: 55000, final_price_cop: 55000, status: 'approved' });
    await distribution.stop();
    db.close();
  });

  it('cleans legacy saved descriptions again at the final send boundary', async () => {
    const captions: string[] = [];
    const { db, directory, distribution } = setup(async (_group, _bytes, _mime, caption) => { captions.push(caption ?? ''); return { messageId: `clean-${captions.length}` }; });
    const image = await photo(); const hash = createHash('sha256').update(image).digest('hex'); const now = new Date().toISOString();
    writeFileSync(join(directory, 'media', `${hash}.png`), image);
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,output_text)
      VALUES ('legacy','Tenis','COD 960\nPRECIO $60.000','{}','approved',?,?,'main','supplier-test',10000,'960',?)`).run(now, now, 'Corrección manual\nPRECIO $70.000\nCAJA Y DOCENA $50.000\nventa por docenas');
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run('legacy-photo','legacy',hash,`${hash}.png`,'image/png',image.length,now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,manual_mode,updated_at) VALUES ('legacy-photo','failed','[]','original',?)").run(now);
    await distribution.sendApprovedProduct('legacy');
    expect(captions).toEqual(['*CORRECCIÓN MANUAL*\n*PRECIO $70.000*', '*CORRECCIÓN MANUAL*\n*PRECIO $70.000*']);
    await distribution.stop(); db.close();
  });

  it('keeps ambiguous prices in review and never sends unless an explicit send operation is called', async () => {
    let sendCalls = 0;
    const { db, ingestion, distribution } = setup(async () => { sendCalls += 1; return { messageId: 'should-not-send' }; }, false);
    const image = await photo();
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'ambiguous', timestampMs: Date.now() - 20_000, text: 'Tenis · Antes $80.000, hoy $60.000', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await distribution.processNow();
    const product = db.prepare('SELECT status FROM products').get() as { status: string };
    expect(product.status).toBe('needs_review');
    expect(sendCalls).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications').get()).toEqual({ count: 0 });
    await distribution.stop();
    db.close();
  });

  it('rejects a real send while the local real-send gate is disabled', async () => {
    let sendCalls = 0;
    const { db, ingestion, distribution } = setup(async () => { sendCalls += 1; return { messageId: 'must-not-send' }; }, false);
    const image = await photo();
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'simulation-only', timestampMs: Date.now() - 20_000, text: 'Tenis, tallas 36-40. Precio 60 mil', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await distribution.processNow();
    expect(db.prepare('SELECT status,final_price_cop FROM products').get()).toEqual({ status: 'approved', final_price_cop: 70000 });
    const productId = (db.prepare('SELECT id FROM products').get() as { id: string }).id;
    await expect(distribution.sendApprovedProduct(productId)).rejects.toThrow('envío real está deshabilitado');
    expect(db.prepare('SELECT COUNT(*) as count FROM outbound_publications').get()).toEqual({ count: 0 });
    expect(sendCalls).toBe(0);
    await distribution.stop();
    db.close();
  });

  it('marks a failed explicit send uncertain and does not retry it on later background ticks', async () => {
    const sendCalls: string[] = [];
    const { db, ingestion, distribution } = setup(async (groupId) => { sendCalls.push(groupId); throw new Error('socket closed during send'); });
    const image = await photo();
    await ingestion.receive({ groupId: 'supplier@g.us', participantId: 'vendor@s.whatsapp.net', messageId: 'uncertain-send', timestampMs: Date.now() - 20_000, text: 'Tenis tallas 38-42. Precio: $70.000', image: { bytes: image, mimeType: 'image/png', expectedAlbumImages: 1 } });
    await distribution.processNow();
    const product = db.prepare('SELECT id FROM products').get() as { id: string };
    analyzedPhotos(db, product.id);
    await expect(distribution.sendApprovedProduct(product.id)).rejects.toThrow('envío quedó incierto');
    await distribution.processNow();
    expect(sendCalls).toEqual(['buyers-a@g.us']);
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_units WHERE status='uncertain'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_publications WHERE status='needs_review'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT level,message FROM application_logs WHERE action='product.publication.uncertain'").get()).toEqual({ level: 'error', message: 'El resultado del envío es incierto. Verifica el grupo antes de reintentar' });
    await distribution.stop();
    db.close();
  });

  it('keeps legacy multi-photo products intact and marks every photo when they are sent', async () => {
    const sent: Array<{ groupId: string; caption?: string; bytes: Buffer }> = [];
    const { db, directory, distribution } = setup(async (groupId, bytes, _mime, caption) => {
      sent.push({ groupId, bytes: Buffer.from(bytes), ...(caption === undefined ? {} : { caption }) });
      return { messageId: `legacy-${sent.length}` };
    });
    const image = await photo();
    const sha = createHash('sha256').update(image).digest('hex');
    const fileName = `${sha}.png`;
    writeFileSync(join(directory,'media',fileName),image);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,marker_text_applied,image_position)
      VALUES (?,?,?,?,60000,70000,?,'approved',? ,?,'main','supplier-test',10000,'001','🌎⭐','top_left')`).run(id,'Histórico dos fotos','Tenis anterior $70.000','{}','Tenis anterior $70.000',now,now);
    const addAsset = db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,?,?)');
    addAsset.run(randomUUID(),id,sha,fileName,'image/png',image.length,0,now);
    addAsset.run(randomUUID(),id,sha,fileName,'image/png',image.length,1,now);
    analyzedPhotos(db, id);
    const result = await distribution.sendApprovedProduct(id);
    expect(result).toEqual({ groupCount: 2, imageCount: 4 });
    expect(sent).toHaveLength(4);
    expect(sent.map((entry) => entry.groupId)).toEqual(['buyers-a@g.us','buyers-a@g.us','buyers-b@g.us','buyers-b@g.us']);
    expect(sent.map((entry) => entry.caption)).toEqual(['*TENIS ANTERIOR $70.000*','','*TENIS ANTERIOR $70.000*','']);
    expect(sent.every((entry) => !entry.bytes.equals(image))).toBe(true);
    expect(readFileSync(join(directory,'media',fileName))).toEqual(image);
    await distribution.stop();
    db.close();
  });

  it('resumes only pending units from the frozen destinations after a settings change', async () => {
    const sent: string[] = [];
    const { db, directory, distribution } = setup(async (groupId) => { sent.push(groupId); return { messageId: `resume-${sent.length}` }; });
    db.prepare('INSERT INTO whatsapp_groups(session_id,jid,subject,updated_at) VALUES (?,?,?,?)').run('main','buyers-c@g.us','Clientes C',new Date().toISOString());
    const image = await photo(); const sha = createHash('sha256').update(image).digest('hex'); const fileName = `${sha}.png`;
    writeFileSync(join(directory,'media',fileName),image);
    const id = randomUUID(); const assetId = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,source_price_cop,final_price_cop,output_text,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,shoe_code,marker_text_applied,image_position)
      VALUES (?,?,?,?,60000,70000,?,'approved',? ,?,'main','supplier-test',10000,NULL,'🌎','bottom_right')`).run(id,'Pendiente','Tenis $70.000','{}','Tenis $70.000',now,now);
    db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,0,?)').run(assetId,id,sha,fileName,'image/png',image.length,now);
    const marked = await saveMarkedImage(directory,image,sha,{ code:null, marker:'🌎', position:'bottom_right' });
    const publicationIds = ['already-sent','still-pending'];
    db.prepare("INSERT INTO outbound_publications(id,product_id,group_id,group_name,generation,status,created_at,updated_at,session_id) VALUES (?,?,'buyers-a@g.us','Clientes A',1,'submitted',?,?,'main'),(?,?,'buyers-b@g.us','Clientes B',1,'queued',?,?,'main')")
      .run(publicationIds[0],id,now,now,publicationIds[1],id,now,now);
    db.prepare("INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,remote_message_id,completed_at,rendered_file_name,rendered_mime_type,caption_snapshot,session_id) VALUES ('confirmed-unit',?,0,?,'submitted','already-accepted',? ,?,?,?,'main')")
      .run(publicationIds[0],assetId,now,`derived/${marked.fileName}`,marked.mimeType,'Tenis $70.000');
    db.prepare("INSERT INTO outbound_units(id,publication_id,position,media_asset_id,status,rendered_file_name,rendered_mime_type,caption_snapshot,session_id) VALUES (?, ?,0,?,'pending',?,?,?,'main')")
      .run('pending-unit',publicationIds[1],assetId,`derived/${marked.fileName}`,marked.mimeType,'Tenis $70.000');
    db.prepare("UPDATE whatsapp_session_settings SET target_group_ids='[\"buyers-c@g.us\"]' WHERE session_id='main'").run();

    const result = await distribution.sendApprovedProduct(id);
    expect(result).toEqual({ groupCount: 1, imageCount: 1 });
    expect(sent).toEqual(['buyers-b@g.us']);
    expect(db.prepare('SELECT group_id,status FROM outbound_publications WHERE product_id=? ORDER BY group_id').all(id)).toEqual([
      { group_id: 'buyers-a@g.us', status: 'submitted' }, { group_id: 'buyers-b@g.us', status: 'submitted' },
    ]);
    expect(db.prepare("SELECT COUNT(*) as count FROM outbound_publications WHERE product_id=? AND group_id='buyers-c@g.us'").get(id)).toEqual({ count: 0 });
    await distribution.stop();
    db.close();
  });
});
