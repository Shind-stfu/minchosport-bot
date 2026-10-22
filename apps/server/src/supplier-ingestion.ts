import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { analyzePrices, extractShoeCode } from '@tenis/core';
import type { AppDatabase } from './database.js';
import { writeApplicationLog } from './application-log.js';

const ASSEMBLY_IDLE_MS = 3_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};

export type IncomingSupplierMessage = {
  sessionId?: string;
  groupId: string;
  messageId: string;
  participantId?: string | null;
  timestampMs: number;
  text: string;
  image?: { bytes: Buffer; mimeType: string; expectedAlbumImages?: number };
};

export class SupplierIngestionService {
  private readonly mediaDirectory: string;

  constructor(private readonly db: AppDatabase, dataDirectory: string, private readonly logger: FastifyBaseLogger, private readonly onImageStored?: (assetId: string) => void) {
    this.mediaDirectory = join(dataDirectory, 'media');
    mkdirSync(this.mediaDirectory, { recursive: true });
  }

  isSupplierGroup(groupId: string, sessionId = 'main'): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(sessionId, groupId));
  }

  async receive(message: IncomingSupplierMessage): Promise<void> {
    const sessionId = message.sessionId ?? 'main';
    const supplier = this.db.prepare('SELECT id,margin_cop,box_margin_cop,marker_text,default_position FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(sessionId, message.groupId) as { id: string; margin_cop: number; box_margin_cop: number; marker_text: string; default_position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' } | undefined;
    if (!supplier || !message.messageId) return;
    if (this.db.prepare('SELECT 1 FROM whatsapp_source_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(sessionId, message.groupId, message.messageId)) return;

    const text = message.text.trim();
    const participant = message.participantId ?? `unknown:${message.messageId}`;
    const eventDate = new Date(message.timestampMs);
    const receivedAt = Number.isNaN(eventDate.valueOf()) ? new Date().toISOString() : eventDate.toISOString();
    const messageTime = Date.parse(receivedAt);
    const recent = !message.image
      ? this.findOpenAssembly(sessionId, message.groupId, participant, messageTime)
        ?? (text ? this.findRecentBlankAssembly(sessionId, message.groupId, participant, messageTime) : undefined)
      : undefined;
    const recentProduct = recent ? this.db.prepare('SELECT raw_text FROM products WHERE id=?').get(recent.product_id) as { raw_text: string } | undefined : undefined;
    const attachText = !message.image && Boolean(text) && recent && !recentProduct?.raw_text.trim();
    const attachImage = Boolean(message.image && !text && recent);
    const attachToExisting = Boolean(attachText || attachImage);
    const productId = attachToExisting && recent ? recent.product_id : randomUUID();
    const existingProduct = attachToExisting && recentProduct ? recentProduct : undefined;
    const nextText = text;
    const currentText = attachToExisting && existingProduct ? existingProduct.raw_text : '';
    const rawText = [currentText, nextText].filter(Boolean).join('\n').slice(0, 10_000);
    const title = rawText.split(/\r?\n/)[0]?.slice(0, 160) || 'Publicación recibida por WhatsApp';
    const analysis = analyzePrices(rawText);
    const shoeCode = extractShoeCode(rawText);
    const now = receivedAt;

    let storedImage: { path: string; sha256: string; extension: string; mimeType: string; size: number } | undefined;
    if (message.image) storedImage = this.storeImage(message.image.bytes, message.image.mimeType);

    let storedAssetId: string | null = null;
    try {
      this.db.transaction(() => {
        if (!attachToExisting) {
          this.db.prepare(`INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id,supplier_id,margin_cop_applied,box_margin_cop_applied,shoe_code,marker_text_applied,image_position)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(productId, title, rawText, JSON.stringify(analysis), 'needs_review', now, now, sessionId, supplier.id, supplier.margin_cop, supplier.box_margin_cop, shoeCode.code, supplier.marker_text, supplier.default_position);
          this.db.prepare(`INSERT INTO whatsapp_product_assemblies(product_id,session_id,group_jid,participant_jid,last_message_at,media_count,expected_media_count,status,association_confident)
            VALUES (?,?,?,?,?,? ,NULL, 'open',?)`)
            .run(productId, sessionId, message.groupId, participant, now, storedImage ? 1 : 0, storedImage && Boolean(text) ? 1 : 0);
          this.db.prepare('INSERT INTO audit_events(id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,?,?,?)')
            .run(randomUUID(), 'product.received.whatsapp', 'product', productId, JSON.stringify({ imageCount: storedImage ? 1 : 0 }), now);
        } else {
          this.db.prepare('UPDATE products SET title=?,raw_text=?,analysis_json=?,shoe_code=?,updated_at=? WHERE id=?')
            .run(title, rawText, JSON.stringify(analysis), shoeCode.code, now, productId);
          this.db.prepare('UPDATE whatsapp_product_assemblies SET last_message_at=?,association_confident=CASE WHEN media_count=1 AND ?<>\'\' THEN 1 ELSE association_confident END WHERE product_id=?')
            .run(now, text, productId);
        }
        if (storedImage) {
          const position = (this.db.prepare('SELECT COUNT(*) as count FROM media_assets WHERE product_id=?').get(productId) as { count: number }).count;
          const fileName = `${storedImage.sha256}${storedImage.extension}`;
          const finalPath = join(this.mediaDirectory, fileName);
          try { renameSync(storedImage.path, finalPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            rmSync(storedImage.path, { force: true });
          }
          storedAssetId = randomUUID();
          this.db.prepare('INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(storedAssetId, productId, storedImage.sha256, fileName, storedImage.mimeType, storedImage.size, position, now);
        }
        this.db.prepare('INSERT INTO whatsapp_source_messages(session_id,group_jid,message_id,participant_jid,product_id,received_at) VALUES (?,?,?,?,?,?)')
          .run(sessionId, message.groupId, message.messageId, participant, productId, now);
        writeApplicationLog(this.db, {
          sessionId, category: 'products', action: 'product.received.whatsapp', entityType: 'product', entityId: productId,
          message: message.image ? 'Se recibió una fotografía del proveedor' : 'Se recibió una descripción del proveedor',
          details: { imageCount: storedImage ? 1 : 0, attachedToExisting: attachToExisting }, createdAt: now,
        });
        const assembly = this.db.prepare('SELECT media_count,expected_media_count FROM whatsapp_product_assemblies WHERE product_id=?').get(productId) as { media_count: number; expected_media_count: number | null };
        if (assembly.expected_media_count !== null && assembly.media_count >= assembly.expected_media_count) {
          this.db.prepare("UPDATE whatsapp_product_assemblies SET status='closed' WHERE product_id=?").run(productId);
        }
      })();
      if (storedAssetId) this.onImageStored?.(storedAssetId);
      this.logger.info({ messageId: message.messageId, productId, image: Boolean(storedImage) }, 'Publicación del grupo proveedor guardada para revisión');
    } catch (error) {
      if (storedImage) rmSync(storedImage.path, { force: true });
      throw error;
    }
  }

  private findOpenAssembly(sessionId: string, groupId: string, participantId: string, timestampMs: number) {
    const rows = this.db.prepare(`SELECT product_id, last_message_at FROM whatsapp_product_assemblies
      WHERE session_id=? AND group_jid=? AND participant_jid=? AND status='open' ORDER BY last_message_at DESC LIMIT 6`)
      .all(sessionId, groupId, participantId) as Array<{ product_id: string; last_message_at: string }>;
    const recent = rows.filter((row) => timestampMs - Date.parse(row.last_message_at) >= 0 && timestampMs - Date.parse(row.last_message_at) <= ASSEMBLY_IDLE_MS);
    return recent.length === 1 ? recent[0] : undefined;
  }

  private findRecentBlankAssembly(sessionId: string, groupId: string, participantId: string, timestampMs: number) {
    const rows = this.db.prepare(`SELECT a.product_id, a.last_message_at FROM whatsapp_product_assemblies a
      JOIN products p ON p.id=a.product_id
      WHERE a.session_id=? AND a.group_jid=? AND a.participant_jid=? AND p.raw_text=''
      ORDER BY a.last_message_at DESC LIMIT 6`).all(sessionId, groupId, participantId) as Array<{ product_id: string; last_message_at: string }>;
    const recent = rows.filter((row) => timestampMs - Date.parse(row.last_message_at) >= 0 && timestampMs - Date.parse(row.last_message_at) <= ASSEMBLY_IDLE_MS);
    // A description arriving after several bare photos cannot be safely matched to one product.
    return recent.length === 1 ? recent[0] : undefined;
  }

  private storeImage(bytes: Buffer, mimeType: string) {
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!extension) throw new Error(`Imagen recibida con formato no admitido: ${mimeType}`);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('La imagen recibida está vacía o supera el límite de 20 MiB.');
    const header = bytes.subarray(0, 12);
    const valid = mimeType === 'image/jpeg'
      ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      : mimeType === 'image/png'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(header.subarray(0, 8))
        : mimeType === 'image/gif'
          ? header.subarray(0, 4).toString('ascii') === 'GIF8'
          : header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new Error('El contenido de la imagen recibida no coincide con su formato.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const temporaryPath = join(this.mediaDirectory, `${randomUUID()}.incoming`);
    writeFileSync(temporaryPath, bytes, { flag: 'wx' });
    return { path: temporaryPath, sha256, extension, mimeType, size: bytes.length };
  }
}
