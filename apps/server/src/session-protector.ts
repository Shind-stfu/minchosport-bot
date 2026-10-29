import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import type { AppDatabase } from './database.js';

export type DataProtector = { protect(data: Buffer): Promise<Buffer>; unprotect(data: Buffer): Promise<Buffer> };
type KeyringEntry = { setSecret(secret: Uint8Array): void; getSecret(): number[] | null };
type KeyringEntryFactory = (service: string, username: string) => KeyringEntry;
const masterKeyLocks = new WeakMap<AppDatabase, Promise<void>>();

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

/** Returns the shared master key, protected by the current operating-system account. */
export async function getOrCreateWhatsAppMasterKey(db: AppDatabase, protector: DataProtector): Promise<Buffer> {
  const previous = masterKeyLocks.get(db);
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  masterKeyLocks.set(db, lock);
  await previous;
  try {
    const row = db.prepare("SELECT value FROM whatsapp_auth_meta WHERE name='data_key_protected'").get() as { value: string } | undefined;
    const key = row ? await protector.unprotect(Buffer.from(row.value, 'base64')) : randomBytes(32);
    if (key.byteLength !== 32) throw new Error('La clave de sesión protegida no tiene el tamaño esperado.');
    if (!row) {
      const encryptedKey = await protector.protect(key);
      db.prepare("INSERT INTO whatsapp_auth_meta(name,value) VALUES ('data_key_protected',?)").run(encryptedKey.toString('base64'));
    }
    return key;
  } finally {
    release();
    if (masterKeyLocks.get(db) === lock) masterKeyLocks.delete(db);
  }
}
