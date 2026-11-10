import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrandCandidateScore } from './image-brand-inspection.js';

export const SNEAKER_MODEL_ID = 'dima806/popular_sneakers_detection';
type ModelRow = { label: string; score: number };

/** Aggregate mutually exclusive sneaker classes; Jordan must precede Nike. */
export function aggregateSneakerBrands(rows: ModelRow[]): BrandCandidateScore[] {
  const totals = new Map<string, number>();
  for (const { label, score } of rows) {
    if (!Number.isFinite(score) || score < 0 || score > 1) continue;
    const normalized = label.toLowerCase();
    const brand = normalized.startsWith('nike_air_jordan_') ? 'Jordan'
      : normalized.startsWith('new_balance_') ? 'New Balance'
        : normalized.startsWith('adidas_') ? 'Adidas'
          : normalized.startsWith('nike_') ? 'Nike'
            : normalized.startsWith('puma_') ? 'Puma'
              : normalized.startsWith('converse_') ? 'Converse'
                : normalized.startsWith('vans_') ? 'Vans'
                  : normalized.startsWith('asics_') ? 'Asics'
                    : normalized.startsWith('reebok_') ? 'Reebok'
                      : normalized.startsWith('salomon_') ? 'Salomon'
                        : normalized.startsWith('yeezy_') ? 'Yeezy' : null;
    if (brand) totals.set(brand, (totals.get(brand) ?? 0) + score);
  }
  return [...totals].map(([brand, score]) => ({ brand, score })).sort((a, b) => b.score - a.score);
}

export async function classifySneaker(source: Uint8Array): Promise<BrandCandidateScore[]> {
  const python = process.env.SNEAKER_MODEL_PYTHON ?? fileURLToPath(new URL('../../../data/sneaker-model-venv/bin/python', import.meta.url));
  if (!existsSync(python)) throw new Error('Falta instalar el entorno del modelo de zapatillas.');
  const script = fileURLToPath(new URL('../scripts/sneaker_classifier.py', import.meta.url));
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('El modelo de zapatillas superó el tiempo límite.')); }, 240_000);
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-1000); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.slice(-300) || 'Falló el modelo de zapatillas.'));
      try {
        const rows: unknown = JSON.parse(stdout);
        if (!Array.isArray(rows) || !rows.every((r) => typeof r?.label === 'string' && typeof r?.score === 'number')) throw new Error('Respuesta inválida del modelo.');
        const brands = aggregateSneakerBrands(rows);
        if (!brands.length) throw new Error('El modelo no devolvió clases conocidas.');
        resolve(brands);
      } catch (error) { reject(error); }
    });
    child.stdin.end(Buffer.from(source));
  });
}
