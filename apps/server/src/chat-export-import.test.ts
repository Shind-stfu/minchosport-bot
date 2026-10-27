import { afterEach, describe, expect, it } from 'vitest';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import sharp from 'sharp';
import yazl from 'yazl';
import { openDatabase } from './database.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';
import { importWhatsAppChatZip, parseWhatsAppChat } from './chat-export-import.js';
import { createApp } from './app.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('WhatsApp export recovery', () => {
  it('recognizes Android and iPhone chat timestamps in Colombia time', () => {
    const messages = parseWhatsAppChat('27/10/26, 07:15 - Ana: IMG-1.jpg (archivo adjunto)\n[27/10/2026, 7:16:02 p. m.] Luis: <attached: IMG-2.jpg>');
    expect(messages.map((item) => new Date(item.timestampMs).toISOString())).toEqual(['2026-10-27T12:15:00.000Z', '2026-10-28T00:16:02.000Z']);
  });

  it('imports only media in the saved range and skips a repeated import', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat-import-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const nowMs = Date.parse('2026-10-27T09:00:00-05:00');
    const now = new Date(nowMs).toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,created_at,updated_at) VALUES ('provider','main','provider@g.us','Bodega',0,?,?)").run(now, now);
    db.prepare("UPDATE whatsapp_session_settings SET reception_start_time='00:00',reception_end_time='08:00' WHERE session_id='main'").run();
    const logger = Fastify({ logger: false }).log;
    const reception = new SupplierReceptionService(db, directory, new SupplierIngestionService(db, directory, logger), logger, () => nowMs);
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('[27/10/26, 7:15:00 a. m.] Ana: IMG-1.jpg (archivo adjunto)\nCódigo 123 Precio $50.000\n[27/10/26, 8:15:00 a. m.] Ana: IMG-2.jpg (archivo adjunto)'), '_chat.txt');
    zip.addBuffer(image, 'IMG-1.jpg');
    zip.addBuffer(image, 'IMG-2.jpg');
    const path = join(directory, 'chat.zip');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(path));
    const first = await importWhatsAppChatZip({ path, db, reception, sessionId: 'main', groupId: 'provider@g.us', nowMs });
    expect(first).toMatchObject({ scanned: 2, inRange: 1, imported: 1, outsideRange: 1, failed: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM products WHERE supplier_id=?').get('provider')).toEqual({ count: 1 });
    expect(db.prepare('SELECT raw_text FROM products WHERE supplier_id=?').get('provider')).toEqual({ raw_text: 'Código 123 Precio $50.000' });
    const second = await importWhatsAppChatZip({ path, db, reception, sessionId: 'main', groupId: 'provider@g.us', nowMs });
    expect(second).toMatchObject({ imported: 0, duplicate: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM products WHERE supplier_id=?').get('provider')).toEqual({ count: 1 });
    const app = createApp({ db, dataDirectory: directory, logLevel: 'silent', supplierReception: reception });
    const boundary = 'chat-export-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chat.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      readFileSync(path), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({ method: 'POST', url: '/api/sessions/main/import-chat?groupId=provider%40g.us',
      headers: { host: '127.0.0.1:3210', 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result).toMatchObject({ imported: 0, duplicate: 1 });
    await app.close();
    await reception.close();
    db.close();
  });
});
