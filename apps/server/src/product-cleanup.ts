import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { AppDatabase } from './database.js';
import { writeApplicationLog } from './application-log.js';

type ProductRow = { id: string; session_id: string; title: string };

export type ProductCleanupResult = {
  productCount: number;
  imageCount: number;
  deletedFiles: number;
  fileErrors: number;
};

function batches<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

/** Removes only the requested rows and their local original and rendered photo files. */
export function removeProducts(
  db: AppDatabase,
  dataDirectory: string,
  products: ProductRow[],
  action: 'products.deleted.manually',
  message: string,
): ProductCleanupResult {
  if (products.length === 0) return { productCount: 0, imageCount: 0, deletedFiles: 0, fileErrors: 0 };
  const productIds = products.map((product) => product.id);
  const idBatches = batches(productIds);
  const originals = idBatches.flatMap((ids) => db.prepare(`SELECT file_name as fileName FROM media_assets WHERE product_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ fileName: string }>);
  const rendered = idBatches.flatMap((ids) => db.prepare(`SELECT u.rendered_file_name as fileName FROM outbound_units u
    JOIN outbound_publications p ON p.id=u.publication_id WHERE p.product_id IN (${ids.map(() => '?').join(',')}) AND u.rendered_file_name IS NOT NULL`).all(...ids) as Array<{ fileName: string }>);
  const sessions = new Map<string, ProductRow[]>();
  for (const product of products) sessions.set(product.session_id, [...(sessions.get(product.session_id) ?? []), product]);
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const [sessionId, sessionProducts] of sessions) {
      const imageCount = batches(sessionProducts.map((product) => product.id)).reduce((total, ids) => {
        const count = db.prepare(`SELECT COUNT(*) as count FROM media_assets WHERE product_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { count: number };
        return total + count.count;
      }, 0);
      const details = { productCount: sessionProducts.length, imageCount };
      writeApplicationLog(db, {
        sessionId, category: 'products', action, entityType: 'product_cleanup', entityId: sessionId,
        message, details, createdAt: now,
      });
      db.prepare('INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), action, 'product_cleanup', sessionId, JSON.stringify(details), now);
    }
    for (const ids of idBatches) db.prepare(`DELETE FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  })();

  return { productCount: products.length, imageCount: originals.length, ...removeUnreferencedFiles(db, dataDirectory, [...originals, ...rendered].map((file) => file.fileName)) };
}

/** Deletes exactly the selected photos; a reference is removed only when its last photo is gone. */
export function removeProductImages(db: AppDatabase, dataDirectory: string, sessionId: string, imageIds: string[]): ProductCleanupResult {
  const assets = batches(imageIds).flatMap((ids) => db.prepare(`SELECT m.id,m.product_id,m.file_name FROM media_assets m
    JOIN products p ON p.id=m.product_id WHERE p.session_id=? AND m.id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, ...ids) as Array<{ id: string; product_id: string; file_name: string }>);
  if (assets.length !== imageIds.length) throw new Error('Una o más fotos ya no existen o no pertenecen a esta cuenta. Actualiza la selección.');
  const productIds = [...new Set(assets.map((asset) => asset.product_id))];
  const publications = batches(productIds).flatMap((ids) => db.prepare(`SELECT p.id,
      (SELECT caption_snapshot FROM outbound_units WHERE publication_id=p.id ORDER BY position LIMIT 1) as caption
    FROM outbound_publications p WHERE p.product_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; caption: string | null }>);
  const rendered = batches(imageIds).flatMap((ids) => db.prepare(`SELECT rendered_file_name as fileName FROM outbound_units
    WHERE media_asset_id IN (${ids.map(() => '?').join(',')}) AND rendered_file_name IS NOT NULL`).all(...ids) as Array<{ fileName: string }>);
  const now = new Date().toISOString();
  let productCount = 0;
  db.transaction(() => {
    for (const ids of batches(imageIds)) {
      const slots = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM outbound_units WHERE media_asset_id IN (${slots})`).run(...ids);
      db.prepare(`DELETE FROM media_assets WHERE id IN (${slots})`).run(...ids);
    }
    for (const ids of batches(productIds)) {
      const slots = ids.map(() => '?').join(',');
      productCount += db.prepare(`DELETE FROM products WHERE id IN (${slots}) AND NOT EXISTS (SELECT 1 FROM media_assets WHERE product_id=products.id)`).run(...ids).changes;
      db.prepare(`UPDATE products SET updated_at=? WHERE id IN (${slots})`).run(now, ...ids);
      db.prepare(`UPDATE whatsapp_product_assemblies SET media_count=(SELECT COUNT(*) FROM media_assets WHERE product_id=whatsapp_product_assemblies.product_id),
        expected_media_count=NULL,status='closed' WHERE product_id IN (${slots})`).run(...ids);
    }
    for (const publication of publications) {
      const units = db.prepare('SELECT id,status FROM outbound_units WHERE publication_id=? ORDER BY position').all(publication.id) as Array<{ id: string; status: string }>;
      if (!units.length) { db.prepare('DELETE FROM outbound_publications WHERE id=?').run(publication.id); continue; }
      // A transmission already handed to WhatsApp cannot be recalled; keep surviving photos reconcilable.
      db.prepare("UPDATE outbound_units SET status='uncertain',completed_at=?,error='Envío detenido al eliminar fotos de esta referencia; verifica el grupo antes de reintentar.' WHERE publication_id=? AND status='transmitting'").run(now, publication.id);
      if (units[0]?.status === 'pending' && publication.caption) {
        db.prepare('UPDATE outbound_units SET caption_snapshot=? WHERE id=?').run(publication.caption, units[0].id);
      }
      const status = units.some((unit) => ['transmitting', 'uncertain'].includes(unit.status)) ? 'needs_review'
        : units.some((unit) => unit.status === 'pending') ? 'queued'
        : units.every((unit) => unit.status === 'submitted') ? 'submitted'
        : units.some((unit) => unit.status === 'failed') ? 'failed' : 'canceled';
      db.prepare('UPDATE outbound_publications SET status=?,updated_at=? WHERE id=?').run(status, now, publication.id);
    }
    const details = { productCount, imageCount: assets.length };
    const action = 'products.images.deleted.manually';
    writeApplicationLog(db, { sessionId, category: 'products', action, entityType: 'product_cleanup', entityId: sessionId,
      message: 'Se eliminaron las fotos seleccionadas del catálogo', details, createdAt: now });
    db.prepare('INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), action, 'product_cleanup', sessionId, JSON.stringify(details), now);
  })();
  return { productCount, imageCount: assets.length, ...removeUnreferencedFiles(db, dataDirectory, [...assets.map((asset) => asset.file_name), ...rendered.map((file) => file.fileName)]) };
}

function removeUnreferencedFiles(db: AppDatabase, dataDirectory: string, fileNames: string[]): Pick<ProductCleanupResult, 'deletedFiles' | 'fileErrors'> {
  const mediaDirectory = resolve(dataDirectory, 'media');
  const derivedDirectory = resolve(mediaDirectory, 'derived');
  const files = new Set(fileNames);
  const referencedOriginals = new Set((db.prepare('SELECT DISTINCT file_name as fileName FROM media_assets').all() as Array<{ fileName: string }>).map((file) => file.fileName));
  const referencedRenders = new Set((db.prepare('SELECT DISTINCT rendered_file_name as fileName FROM outbound_units WHERE rendered_file_name IS NOT NULL').all() as Array<{ fileName: string }>).map((file) => file.fileName));
  let deletedFiles = 0;
  let fileErrors = 0;
  for (const fileName of files) {
    const path = resolve(mediaDirectory, fileName);
    const pathFromMediaDirectory = relative(mediaDirectory, path);
    if (!pathFromMediaDirectory || pathFromMediaDirectory === '..' || pathFromMediaDirectory.startsWith(`..${sep}`)) {
      fileErrors += 1;
      continue;
    }
    const isDerivedFile = path.startsWith(`${derivedDirectory}${sep}`);
    if (isDerivedFile ? referencedRenders.has(fileName) : referencedOriginals.has(fileName)) continue;
    try {
      if (existsSync(path)) { rmSync(path, { force: true }); deletedFiles += 1; }
    } catch {
      fileErrors += 1;
    }
  }
  return { deletedFiles, fileErrors };
}
