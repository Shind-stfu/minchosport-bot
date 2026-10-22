import type { AppDatabase } from './database.js';
import { codeOnCornerLabel } from './image-inspection.js';

export type MarkMode = 'original' | 'mark_all' | 'mark_code' | 'mark_world';
export type CornerLabel = { corner: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'; text: string; code: string | null; hasWorld: boolean; worldUncertain: boolean };
export type MarkDecision = { status: 'pending' | 'ready' | 'review'; mode: MarkMode | null; reason: string; manual: boolean };

function matchingCode(requested: string, observed: string): boolean {
  const target = requested.trim().toUpperCase();
  const found = observed.trim().toUpperCase().replace(/\s+/gu, ' ');
  const compact = found.replace(/\s+/gu, '');
  return found === target
    || compact === `${target}H`
    || compact === `${target}D`
    || /^\d{3,6}$/u.test(target) && compact.startsWith(target) && /^[A-Z]$/u.test(compact.slice(target.length));
}

export function decideMarking(requestedCode: string | null, regions: CornerLabel[], inspectionStatus: string, error: string | null, manualMode: MarkMode | null = null): MarkDecision {
  if (manualMode) {
    if (['mark_code', 'mark_all'].includes(manualMode) && !requestedCode?.trim()) {
      return { status: 'review', mode: null, reason: 'Indica un código para aplicar la marca elegida manualmente.', manual: true };
    }
    const action = { original: 'Se conservará la fotografía original.', mark_code: 'Se añadirá solo el código.', mark_world: 'Se añadirá solo el mundo.', mark_all: 'Se añadirán código y mundo.' }[manualMode];
    return { status: 'ready', mode: manualMode, reason: `Decisión manual: ${action}`, manual: true };
  }
  if (inspectionStatus === 'pending' || inspectionStatus === 'running' || !inspectionStatus) return { status: 'pending', mode: null, reason: 'La fotografía está pendiente de análisis local.', manual: false };
  if (inspectionStatus === 'failed' || error) return { status: 'review', mode: null, reason: `No se pudo verificar la marca de la fotografía${error ? `: ${error}` : '.'}`, manual: false };
  const observed = regions.filter((region) => region.code || region.hasWorld || region.worldUncertain);
  if (observed.some((region) => region.worldUncertain)) return { status: 'review', mode: null, reason: 'Hay una posible marca de mundo que no se pudo confirmar.', manual: false };
  const codes = observed.filter((region) => region.code);
  if (requestedCode && codes.some((region) => !matchingCode(requestedCode, region.code!))) {
    return { status: 'review', mode: null, reason: `La fotografía muestra ${codes.map((region) => region.code).join(', ')}, distinto del código ${requestedCode}.`, manual: false };
  }
  if (codes.length > 1 || observed.filter((region) => region.hasWorld).length > 1) {
    return { status: 'review', mode: null, reason: 'Hay varias etiquetas posibles en la fotografía.', manual: false };
  }
  const matching = requestedCode ? codes[0] : undefined;
  const world = observed.find((region) => region.hasWorld);
  if (matching && world && matching.corner !== world.corner) {
    return { status: 'review', mode: null, reason: 'El código y el mundo parecen estar en lugares distintos.', manual: false };
  }
  if (matching && world) return { status: 'ready', mode: 'original', reason: `El código ${matching.code} y el mundo ya están juntos en la foto original.`, manual: false };
  if (!requestedCode && world) return { status: 'ready', mode: 'original', reason: 'La foto original ya tiene el mundo.', manual: false };
  if (matching) return { status: 'ready', mode: 'mark_world', reason: `El código ${matching.code} ya está; se añadirá solo el mundo.`, manual: false };
  if (world) return { status: 'ready', mode: requestedCode ? 'mark_code' : 'original', reason: requestedCode ? 'El mundo ya está; se añadirá solo el código.' : 'La foto original ya tiene el mundo.', manual: false };
  return { status: 'ready', mode: requestedCode ? 'mark_all' : 'mark_world', reason: 'No se encontró una etiqueta previa; se añadirá la marca configurada.', manual: false };
}

export function readMarkDecision(db: AppDatabase, assetId: string, requestedCode: string | null): MarkDecision {
  const row = db.prepare(`SELECT s.status,s.regions_json,s.manual_mode,s.error,i.ocr_text FROM image_marking_state s
    LEFT JOIN image_inspections i ON i.media_asset_id=s.media_asset_id WHERE s.media_asset_id=?`).get(assetId) as { status: string; regions_json: string; manual_mode: MarkMode | null; error: string | null; ocr_text: string | null } | undefined;
  if (!row) return decideMarking(requestedCode, [], 'pending', null);
  // An explicit operator choice must also work with failed or unreadable OCR data.
  if (row.manual_mode) return decideMarking(requestedCode, [], row.status, row.error, row.manual_mode);
  let regions: CornerLabel[] = [];
  try {
    regions = (JSON.parse(row.regions_json) as CornerLabel[]).map((region) => ({
      ...region,
      // Reinterpret old OCR text when the code parser gains support for a label variant.
      code: region.text.length > 120 ? codeOnCornerLabel(region.text) : region.code ?? codeOnCornerLabel(region.text),
    }));
  }
  catch { return { status: 'review', mode: null, reason: 'No se pudo leer el análisis de esta foto.', manual: false }; }
  const decision = decideMarking(requestedCode, regions, row.status, row.error, row.manual_mode);
  if (!row.manual_mode && requestedCode && ['mark_all', 'mark_code'].includes(decision.mode ?? '') && row.ocr_text?.split(/\r?\n/u)
    .some((line) => { const code = codeOnCornerLabel(line); return code && matchingCode(requestedCode, code); })) {
    return { status: 'review', mode: null, reason: `El OCR general encontró ${requestedCode}, pero no se pudo confirmar su ubicación en la foto. Vuelve a analizarla o revisa el original.`, manual: false };
  }
  return decision;
}

export function markOptions(decision: MarkDecision, requestedCode: string | null) {
  if (decision.status !== 'ready' || !decision.mode) throw new Error(decision.reason);
  return {
    sourceCode: decision.mode === 'original' || decision.mode === 'mark_world' ? requestedCode : null,
    sourceHasWorld: decision.mode === 'original' || decision.mode === 'mark_code',
  };
}
