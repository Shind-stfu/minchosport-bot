import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { openDatabase } from './database.js';
import { EncryptedWhatsAppAuth, macOSKeychainProtector } from './encrypted-auth.js';
import { EncryptedWhatsmeowStorage } from './whatsmeow-storage.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tenis-auth-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'business.sqlite'));
  const protector = {
    protect: async (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa5)),
    unprotect: async (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa5)),
  };
  return { db, protector };
}

describe('encrypted WhatsApp authentication store', () => {
  it('persists Signal keys as authenticated ciphertext and restores buffers', async () => {
    const { db, protector } = setup();
    const initial = await EncryptedWhatsAppAuth.create(db, protector);
    const { state, saveCreds } = await initial.state();
    await state.keys.set({ 'pre-key': { '42': { public: Buffer.from('public-key'), private: Buffer.from('private-key') } } });
    const appStateKey = proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from('app-state-key-data') });
    await state.keys.set({ 'app-state-sync-key': { 'key-1': appStateKey } });
    state.creds.advSecretKey = 'credential-secret-for-test';
    await saveCreds();
    const stored = db.prepare('SELECT ciphertext FROM whatsapp_auth_records ORDER BY record_type').all() as Array<{ ciphertext: string }>;
    expect(JSON.stringify(stored)).not.toContain('private-key');
    expect(JSON.stringify(stored)).not.toContain('credential-secret-for-test');

    const restored = await EncryptedWhatsAppAuth.create(db, protector);
    const savedState = await restored.state();
    const key = await savedState.state.keys.get('pre-key', ['42']);
    const restoredAppStateKey = await savedState.state.keys.get('app-state-sync-key', ['key-1']);
    expect(Buffer.from(key['42']!.public)).toEqual(Buffer.from('public-key'));
    expect(Buffer.from(key['42']!.private)).toEqual(Buffer.from('private-key'));
    expect(restoredAppStateKey['key-1']).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(restoredAppStateKey['key-1']!.keyData!)).toEqual(Buffer.from('app-state-key-data'));
    expect(savedState.state.creds.advSecretKey).toBe('credential-secret-for-test');
    db.close();
  });

  it('protects and retrieves the master key through the macOS Keychain adapter', async () => {
    let keychainSecret: number[] | null = null;
    const protector = macOSKeychainProtector(() => ({
      setSecret: (secret) => { keychainSecret = Array.from(secret); },
      getSecret: () => keychainSecret,
    }));
    const masterKey = Buffer.from('local-master-key');
    const marker = await protector.protect(masterKey);
    expect(marker.toString()).toBe('macos-keychain-v1');
    expect(marker).not.toContain(masterKey.toString());
    expect(await protector.unprotect(marker)).toEqual(masterKey);
  });

  it('derives independent whatsmeow keys per account and encrypts its pairing marker', async () => {
    const { db, protector } = setup();
    const [main, secondary] = await Promise.all([
      EncryptedWhatsmeowStorage.create(db, protector, 'main'),
      EncryptedWhatsmeowStorage.create(db, protector, 'secondary'),
    ]);
    const marker = main.encrypt({ engine: 'whatsmeow', paired: true });
    expect(main.keyHex()).toMatch(/^[a-f0-9]{64}$/);
    expect(marker).not.toContain('whatsmeow');
    expect(marker).not.toContain('paired');

    const restored = await EncryptedWhatsmeowStorage.create(db, protector, 'main');
    expect(restored.keyHex()).toBe(main.keyHex());
    expect(secondary.keyHex()).not.toBe(main.keyHex());
    expect(restored.decrypt(marker)).toEqual({ engine: 'whatsmeow', paired: true });
    db.close();
  });

  it('isolates authentication stores and reset scope between account sessions', async () => {
    const { db, protector } = setup();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO whatsapp_sessions(id,name,created_at) VALUES ('second','Cuenta secundaria',?)").run(now);
    db.prepare("INSERT INTO whatsapp_session_settings(session_id,target_group_ids,updated_at) VALUES ('second','[]',?)").run(now);
    db.prepare("INSERT INTO session_distribution_control(session_id,status,updated_at) VALUES ('second','stopped',?)").run(now);

    const first = await EncryptedWhatsAppAuth.create(db, protector, 'main');
    const firstState = await first.state();
    firstState.state.creds.advSecretKey = 'first-account';
    await firstState.saveCreds();
    const second = await EncryptedWhatsAppAuth.create(db, protector, 'second');
    const secondState = await second.state();
    secondState.state.creds.advSecretKey = 'second-account';
    await secondState.saveCreds();

    const restoredMain = await (await EncryptedWhatsAppAuth.create(db, protector, 'main')).state();
    const restoredSecond = await (await EncryptedWhatsAppAuth.create(db, protector, 'second')).state();
    expect(restoredMain.state.creds.advSecretKey).toBe('first-account');
    expect(restoredSecond.state.creds.advSecretKey).toBe('second-account');
    db.prepare("DELETE FROM whatsapp_auth_records WHERE session_id='second'").run();
    expect(db.prepare("SELECT COUNT(*) as count FROM whatsapp_auth_records WHERE session_id='main'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) as count FROM whatsapp_auth_records WHERE session_id='second'").get()).toEqual({ count: 0 });
    db.close();
  });
});
