export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const endpoint = `/api${path}`;
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch {
    throw new Error(`No se pudo conectar con el servidor local al consultar ${endpoint}. Comprueba que pnpm dev siga ejecutándose y revisa la terminal.`);
  }

  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`El servidor local respondió vacío al consultar ${endpoint} (HTTP ${response.status}). Comprueba que el backend esté activo y revisa la terminal.`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    const excerpt = body.replace(/\s+/g, ' ').slice(0, 140);
    throw new Error(`El servidor devolvió una respuesta no válida al consultar ${endpoint} (HTTP ${response.status}): ${excerpt}`);
  }

  if (!response.ok) {
    const serverMessage = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `No se pudo completar la operación (HTTP ${response.status}).`;
    throw new Error(serverMessage);
  }
  return payload as T;
}
