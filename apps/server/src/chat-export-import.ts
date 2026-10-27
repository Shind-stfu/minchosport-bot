import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { AppDatabase } from './database.js';
import { isInRecoveryWindow, readReceptionSchedule } from './reception-schedule.js';
import type { SupplierReceptionService } from './supplier-reception.js';

const MAX_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 600 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

type ChatMessage = { timestampMs: number; sender: string; body: string; index: number };
export type ChatImportResult = { scanned: number; inRange: number; imported: number; pending: number; duplicate: number; missingMedia: number; outsideRange: number; failed: number };

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error('ZIP inválido.')) : resolve(zip)));
}

function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let expanded = 0;
    zip.on('entry', (entry) => {
      expanded += entry.uncompressedSize;
      if (entries.length >= MAX_ENTRIES || expanded > MAX_EXPANDED_BYTES) { reject(new Error('La exportación supera los límites de seguridad.')); return; }
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) return Promise.reject(new Error(`Archivo demasiado grande: ${basename(entry.fileName)}`));
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(error ?? new Error('No se pudo abrir el archivo ZIP.')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { stream.destroy(new Error('El archivo supera el límite permitido.')); return; }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function parseHeader(line: string): { timestampMs: number; sender: string; body: string } | null {
  const normalized = line.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/[\u00a0\u202f]/g, ' ');
  const match = /^(?:\[)?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap](?:\s*\.\s*m\s*\.?|m))?\s*(?:\]\s*|\s+-\s+)(.+)$/i.exec(normalized);
  if (!match) return null;
  const split = match[8]!.indexOf(': ');
  if (split < 1) return null;
  const day = Number(match[1]); const month = Number(match[2]);
  const yearValue = Number(match[3]); const year = yearValue < 100 ? 2000 + yearValue : yearValue;
  let hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6] ?? 0);
  const meridiem = match[7]?.replace(/[.\s]/g, '').toLowerCase();
  if (meridiem) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (meridiem === 'pm' ? 12 : 0); }
  if (day < 1 || day > 31 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // Exported local WhatsApp chats use the phone's wall clock. This app's range is fixed to Colombia.
  const timestampMs = Date.UTC(year, month - 1, day, hour + 5, minute, second);
  const check = new Date(timestampMs - 5 * 3_600_000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { timestampMs, sender: match[8]!.slice(0, split), body: match[8]!.slice(split + 2) };
}

export function parseWhatsAppChat(text: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const header = parseHeader(line);
    if (header) messages.push({ ...header, index: messages.length });
    else if (messages.length) messages[messages.length - 1]!.body += `\n${line}`;
  }
  return messages;
}

function cleanCaption(body: string, fileName: string): string {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.replace(new RegExp(`(?:<\s*(?:attached|adjunto)\s*:\s*)?${escaped}(?:\s*>|\s*\((?:archivo adjunto|file attached)\))?`, 'gi'), '')
    .replace(/\(\s*(?:archivo adjunto|file attached)\s*\)/gi, '')
    .replace(/<\s*(?:imagen|image) omitida\s*>/gi, '').trim();
}

/** Import a WhatsApp chat export locally. Never calls a WhatsApp send or reconnect method. */
export async function importWhatsAppChatZip(options: { path: string; db: AppDatabase; reception: SupplierReceptionService; sessionId: string; groupId: string; nowMs?: number }): Promise<ChatImportResult> {
  const { path, db, reception, sessionId, groupId } = options;
  const supplier = db.prepare('SELECT id FROM supplier_profiles WHERE session_id=? AND source_group_id=? AND archived_at IS NULL').get(sessionId, groupId) as { id: string } | undefined;
  if (!supplier) throw new Error('Selecciona un grupo proveedor activo de esta cuenta.');
  const zip = await openZip(path);
  try {
    const entries = await listEntries(zip);
    const chatEntries = entries.filter((entry) => /(?:^|\/)(?:_chat|chat de whatsapp|whatsapp chat).*\.txt$/i.test(entry.fileName) || /\.txt$/i.test(entry.fileName));
    if (chatEntries.length !== 1) throw new Error('El ZIP debe contener exactamente un archivo TXT de chat exportado.');
    const messages = parseWhatsAppChat((await readEntry(zip, chatEntries[0]!, MAX_TEXT_BYTES)).toString('utf8'));
    if (!messages.length) throw new Error('No se reconocieron fechas y remitentes en el TXT. Exporta el chat con archivos multimedia desde WhatsApp.');
    const imageEntries = new Map<string, Entry>();
    for (const entry of entries) {
      const name = basename(entry.fileName);
      if (IMAGE_TYPES[name.split('.').at(-1)?.toLowerCase() ?? '']) {
        const key = name.toLowerCase();
        if (imageEntries.has(key)) throw new Error(`El ZIP contiene nombres de imagen repetidos: ${name}`);
        imageEntries.set(key, entry);
      }
    }
    const result: ChatImportResult = { scanned: messages.length, inRange: 0, imported: 0, pending: 0, duplicate: 0, missingMedia: 0, outsideRange: 0, failed: 0 };
    const schedule = readReceptionSchedule(db, sessionId);
    const nowMs = options.nowMs ?? Date.now();
    const pendingIds: string[] = [];
    for (const message of messages) {
      if (!isInRecoveryWindow(message.timestampMs, schedule, nowMs)) { result.outsideRange++; continue; }
      result.inRange++;
      const files = [...imageEntries.entries()].filter(([name]) => message.body.toLowerCase().includes(name));
      if (!files.length) {
        if (/\.(?:jpe?g|png|webp|gif)\b|<\s*(?:image|imagen) omitted|imagen omitida/i.test(message.body)) result.missingMedia++;
        continue;
      }
      for (const [name, entry] of files) {
        try {
          const bytes = await readEntry(zip, entry, MAX_IMAGE_BYTES);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const existing = db.prepare(`SELECT 1 FROM media_assets a JOIN products p ON p.id=a.product_id
            WHERE a.sha256=? AND p.supplier_id=? AND ABS(strftime('%s',p.created_at)*1000-?)<60000 LIMIT 1`)
            .get(sha256, supplier.id, message.timestampMs);
          if (existing) { result.duplicate++; continue; }
          const id = `export:${createHash('sha256').update(`${groupId}\0${message.timestampMs}\0${message.sender}\0${name}\0${sha256}`).digest('hex')}`;
          const outcome = await reception.capture({ sessionId, groupId, messageId: id, participantId: message.sender, timestampMs: message.timestampMs,
            receptionMode: 'recovery', text: cleanCaption(message.body, basename(entry.fileName)), image: { bytes, mimeType: IMAGE_TYPES[name.split('.').at(-1)!]! } }, true);
          if (outcome === 'duplicate') result.duplicate++;
          else if (outcome === 'pending') pendingIds.push(id);
          else result.failed++;
        } catch { result.failed++; }
      }
    }
    await reception.scheduleChanged(sessionId);
    for (const id of pendingIds) {
      const row = db.prepare('SELECT status FROM supplier_inbox_messages WHERE session_id=? AND group_jid=? AND message_id=?').get(sessionId, groupId, id) as { status: string } | undefined;
      if (row?.status === 'processed') result.imported++;
      else if (row?.status === 'pending' || row?.status === 'processing') result.pending++;
      else result.failed++;
    }
    return result;
  } finally { zip.close(); }
}
