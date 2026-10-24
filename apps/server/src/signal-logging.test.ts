import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);
const baileysRequire = createRequire(require.resolve('@whiskeysockets/baileys'));
const SessionRecord = baileysRequire('libsignal/src/session_record.js');
const signalCrypto = baileysRequire('libsignal/src/crypto.js') as { verifyMAC(data: Buffer, key: Buffer, mac: Buffer, length: number): void };
afterEach(() => vi.restoreAllMocks());

describe('Signal dependency log redaction', () => {
  it('opens, closes and evicts sessions without passing any session or key objects to console', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const record = new SessionRecord();
    const entry = { indexInfo: { closed: 0 }, currentRatchet: { privKey: Buffer.from('synthetic-private-key'), rootKey: Buffer.from('synthetic-root-key') } };
    record.openSession(entry); expect(entry.indexInfo.closed).toBe(-1);
    record.closeSession(entry); expect(entry.indexInfo.closed).toBeGreaterThan(0);
    record.closeSession(entry);
    record.sessions = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`session-${i}`, { ...entry, indexInfo: { closed: i + 1 } }]));
    record.removeOldSessions(); expect(Object.keys(record.sessions)).toHaveLength(40);
    const calls = [...info.mock.calls, ...warn.mock.calls];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((args) => args.length === 1 && typeof args[0] === 'string')).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/synthetic-private|synthetic-root|privKey|rootKey/);
  });
  it('still validates message authentication and rejects tampered messages', () => {
    const key = Buffer.alloc(32, 7); const data = Buffer.from('synthetic signal message');
    const mac = createHmac('sha256', key).update(data).digest();
    expect(() => signalCrypto.verifyMAC(data, key, mac, 32)).not.toThrow();
    expect(() => signalCrypto.verifyMAC(Buffer.from('changed message'), key, mac, 32)).toThrow('Bad MAC');
    expect(() => signalCrypto.verifyMAC(data, key, mac.subarray(0, 5), 32)).toThrow('Bad MAC length');
  });
});
