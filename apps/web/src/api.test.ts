import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('local API response handling', () => {
  it('returns parsed JSON for successful requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
    await expect(api<{ ok: boolean }>('/logs?sessionId=main')).resolves.toEqual({ ok: true });
  });

  it('explains an empty proxy response and identifies the failing endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    await expect(api('/sessions')).rejects.toThrow('respondió vacío al consultar /api/sessions (HTTP 502)');
  });

  it('shows a short excerpt when the server responds with non-JSON content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy unavailable</html>', { status: 503 })));
    await expect(api('/logs')).rejects.toThrow('respuesta no válida al consultar /api/logs (HTTP 503): <html>proxy unavailable</html>');
  });

  it('uses the server error message from valid JSON error responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Cuenta no encontrada."}', { status: 404 })));
    await expect(api('/logs?sessionId=missing')).rejects.toThrow('Cuenta no encontrada.');
  });
});
