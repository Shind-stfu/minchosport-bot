import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AppDatabase } from './database.js';
import { getOrCreateWhatsAppMasterKey, type DataProtector } from './session-protector.js';

/** Keeps whatsmeow's Signal database encrypted with a per-account key. */
export class EncryptedWhatsmeowStorage {
  private constructor(private readonly key: Buffer) {}

  static async create(db: AppDatabase, protector: DataProtector, sessionId: string): Promise<EncryptedWhatsmeowStorage> {
    const masterKey = await getOrCreateWhatsAppMasterKey(db, protector);
    const key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.from('mincho-sport-whatsmeow-v1'), Buffer.from(sessionId), 32));
    return new EncryptedWhatsmeowStorage(key);
  }

  keyHex() {
    return this.key.toString('hex');
  }

  encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((item) => item.toString('base64')).join('.');
  }

  decrypt<T>(encoded: string): T {
    const [ivText, tagText, ciphertextText] = encoded.split('.');
    if (!ivText || !tagText || !ciphertextText) throw new Error('El registro cifrado de WhatsApp está incompleto.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  }
}
