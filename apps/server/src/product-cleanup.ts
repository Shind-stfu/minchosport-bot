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

  const mediaDirectory = resolve(dataDirectory, 'media');
  const derivedDirectory = resolve(mediaDirectory, 'derived');
  const files = new Set([...originals, ...rendered].map((file) => file.fileName));
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
  return { productCount: products.length, imageCount: originals.length, deletedFiles, fileErrors };
}
