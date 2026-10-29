import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { initAuthCreds, makeCacheableSignalKeyStore, BufferJSON, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap, SignalKeyStore } from '@whiskeysockets/baileys';
import type { AppDatabase } from './database.js';
import { getOrCreateWhatsAppMasterKey } from './session-protector.js';
import type { DataProtector } from './session-protector.js';
export { currentUserProtector, macOSKeychainProtector, windowsCurrentUserProtector } from './session-protector.js';
export type { DataProtector } from './session-protector.js';

export class EncryptedWhatsAppAuth {
  private constructor(private readonly db: AppDatabase, private readonly key: Buffer, private readonly sessionId: string) {}

  static async create(db: AppDatabase, protector: DataProtector, sessionId = 'main'): Promise<EncryptedWhatsAppAuth> {
    const key = await getOrCreateWhatsAppMasterKey(db, protector);
    return new EncryptedWhatsAppAuth(db, key, sessionId);
  }

  async state(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const row = this.db.prepare("SELECT ciphertext FROM whatsapp_auth_records WHERE session_id=? AND record_type='creds' AND record_id='main'").get(this.sessionId) as { ciphertext: string } | undefined;
    const creds = row ? this.decrypt<AuthenticationState['creds']>(row.ciphertext) : initAuthCreds();
    const rawKeys: SignalKeyStore = {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        const query = this.db.prepare('SELECT record_id as id, ciphertext FROM whatsapp_auth_records WHERE session_id=? AND record_type=? AND record_id=?');
        for (const id of ids) {
          const stored = query.get(this.sessionId, type, id) as { id: string; ciphertext: string } | undefined;
          if (stored) {
            const value = this.decrypt<SignalDataTypeMap[T]>(stored.ciphertext);
            // Baileys' reference file store restores this protobuf class on read.
            result[id] = (type === 'app-state-sync-key' && value
              ? proto.Message.AppStateSyncKeyData.fromObject(value as never)
              : value) as SignalDataTypeMap[T];
          }
        }
        return result;
      },
      set: async (data) => {
        const write = this.db.prepare('INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES (?,?,?,?) ON CONFLICT(session_id,record_type,record_id) DO UPDATE SET ciphertext=excluded.ciphertext');
        const remove = this.db.prepare('DELETE FROM whatsapp_auth_records WHERE session_id=? AND record_type=? AND record_id=?');
        this.db.transaction(() => {
          for (const [type, records] of Object.entries(data)) {
            if (!records) continue;
            for (const [id, value] of Object.entries(records)) {
              if (value === null) remove.run(this.sessionId, type, id);
              else write.run(this.sessionId, type, id, this.encrypt(value));
            }
          }
        })();
      },
    };
    const credsSave = this.db.prepare("INSERT INTO whatsapp_auth_records(session_id,record_type,record_id,ciphertext) VALUES (?,'creds','main',?) ON CONFLICT(session_id,record_type,record_id) DO UPDATE SET ciphertext=excluded.ciphertext");
    return {
      state: { creds, keys: makeCacheableSignalKeyStore(rawKeys) },
      saveCreds: async () => { credsSave.run(this.sessionId, this.encrypt(creds)); },
    };
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((item) => item.toString('base64')).join('.');
  }

  private decrypt<T>(encoded: string): T {
    const [ivText, tagText, ciphertextText] = encoded.split('.');
    if (!ivText || !tagText || !ciphertextText) throw new Error('El registro cifrado de WhatsApp está incompleto.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext, BufferJSON.reviver) as T;
  }
}
