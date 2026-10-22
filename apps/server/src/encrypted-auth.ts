import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { initAuthCreds, makeCacheableSignalKeyStore, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap, SignalKeyStore } from '@whiskeysockets/baileys';
import type { AppDatabase } from './database.js';

export type DataProtector = { protect(data: Buffer): Promise<Buffer>; unprotect(data: Buffer): Promise<Buffer> };
type KeyringEntry = { setSecret(secret: Uint8Array): void; getSecret(): number[] | null };
type KeyringEntryFactory = (service: string, username: string) => KeyringEntry;

function runPowerShell(operation: 'protect' | 'unprotect', input: Buffer): Promise<Buffer> {
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$text = [Console]::In.ReadToEnd()',
    '$data = [Convert]::FromBase64String($text)',
    `$result = [System.Security.Cryptography.ProtectedData]::${method}($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve(Buffer.from(Buffer.concat(out).toString('utf8').trim(), 'base64'))
      : reject(new Error(`Windows DPAPI ${operation} falló: ${Buffer.concat(errors).toString('utf8').trim() || `código ${code}`}`)));
    child.stdin.end(input.toString('base64'));
  });
}

export const windowsCurrentUserProtector: DataProtector = {
  protect: (data) => runPowerShell('protect', data),
  unprotect: (data) => runPowerShell('unprotect', data),
};

export function macOSKeychainProtector(entryFactory: KeyringEntryFactory = (service, username) => new Entry(service, username)) {
  const entry = entryFactory('BotDistribuidorTenis', 'whatsapp-auth-master-key');
  return {
    protect: async (data: Buffer) => {
      entry.setSecret(data);
      return Buffer.from('macos-keychain-v1', 'utf8');
    },
    unprotect: async (marker: Buffer) => {
      if (marker.toString('utf8') !== 'macos-keychain-v1') throw new Error('La clave se protegió en otro sistema operativo.');
      const secret = entry.getSecret();
      if (!secret) throw new Error('No se encontró la clave de sesión en el Llavero de macOS.');
      return Buffer.from(secret);
    },
  } satisfies DataProtector;
}

export function currentUserProtector(platform = process.platform): DataProtector {
  if (platform === 'win32') return windowsCurrentUserProtector;
  if (platform === 'darwin') return macOSKeychainProtector();
  throw new Error('La sesión protegida requiere Windows DPAPI o el Llavero de macOS.');
}

export class EncryptedWhatsAppAuth {
  private constructor(private readonly db: AppDatabase, private readonly key: Buffer, private readonly sessionId: string) {}

  static async create(db: AppDatabase, protector: DataProtector, sessionId = 'main'): Promise<EncryptedWhatsAppAuth> {
    const row = db.prepare("SELECT value FROM whatsapp_auth_meta WHERE name='data_key_protected'").get() as { value: string } | undefined;
    const key = row ? await protector.unprotect(Buffer.from(row.value, 'base64')) : randomBytes(32);
    if (key.byteLength !== 32) throw new Error('La clave de sesión protegida no tiene el tamaño esperado.');
    if (!row) {
      const encryptedKey = await protector.protect(key);
      db.prepare("INSERT INTO whatsapp_auth_meta(name,value) VALUES ('data_key_protected',?)").run(encryptedKey.toString('base64'));
    }
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
          if (stored) result[id] = this.decrypt<SignalDataTypeMap[T]>(stored.ciphertext);
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
