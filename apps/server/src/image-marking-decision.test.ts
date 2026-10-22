import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { decideMarking, readMarkDecision, type CornerLabel, type MarkMode } from './image-marking-decision.js';
import { codeOnCornerLabel, type ImageInspection } from './image-inspection.js';
import { ImageInspectionCoordinator } from './image-inspection-coordinator.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { openDatabase } from './database.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const label = (code: string | null, hasWorld: boolean, corner: CornerLabel['corner'] = 'top_left'): CornerLabel =>
  ({ corner, text: `${code ?? ''} ${hasWorld ? '🌍' : ''}`, code, hasWorld, worldUncertain: false });

describe('decisión de marcado por fotografía', () => {
  it.each<MarkMode>(['original', 'mark_code', 'mark_world', 'mark_all'])('respeta %s ante falsos positivos, negativos, conflictos y fallos', (mode) => {
    for (const regions of [[], [label('960', true)], [label('999', true)]]) {
      for (const status of ['pending', 'running', 'complete', 'failed']) {
        expect(decideMarking('960', regions, status, 'Error OCR', mode)).toMatchObject({ status: 'ready', mode, manual: true });
      }
    }
  });

  it('no aprueba una marca que requiere código si el código se ha eliminado', () => {
    expect(decideMarking(null, [], 'complete', null, 'mark_code').status).toBe('review');
    expect(decideMarking(null, [], 'complete', null, 'mark_all').status).toBe('review');
    expect(decideMarking(null, [], 'failed', 'OCR', 'original').status).toBe('ready');
    expect(decideMarking(null, [], 'failed', 'OCR', 'mark_world').status).toBe('ready');
  });
  it('conserva el original cuando 960 A y el mundo ya aparecen para el código 960', () => {
    expect(decideMarking('960', [label('960 A', true)], 'complete', null)).toMatchObject({ status: 'ready', mode: 'original' });
    expect(decideMarking('096', [label('960 A', true)], 'complete', null).status).toBe('review');
    expect(decideMarking('096-215', [label('096-215', true)], 'complete', null).mode).toBe('original');
    expect(decideMarking('096-215', [label('096-215 H', true)], 'complete', null).mode).toBe('original');
    expect(decideMarking('096-215', [label('096-215 D', true)], 'complete', null).mode).toBe('original');
    expect(codeOnCornerLabel('960 A 🌍')).toBe('960 A');
    expect(codeOnCornerLabel('- —\n954A © LW\nY “e')).toBe('954 A');
    expect(decideMarking('954', [label('954 A', true)], 'complete', null)).toMatchObject({ status: 'ready', mode: 'original' });
    expect(decideMarking('3846', [label('3846 D', true)], 'complete', null)).toMatchObject({ status: 'ready', mode: 'original' });
    expect(codeOnCornerLabel('960 McQUEEN')).toBe('960');
    expect(codeOnCornerLabel('PRECIO $60.000 · TALLAS 38-42')).toBeNull();
  });

  it('does not mark over an old scan that saw the caption code but misplaced a noisy number', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-ocr-match-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('product-960','Tenis','COD 960','{}','needs_review',?,?,'main')").run(now, now);
    db.prepare("INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES ('asset-960','product-960','hash','photo.jpg','image/jpeg',1,0,?)").run(now);
    db.prepare("INSERT INTO image_marking_state(media_asset_id,status,regions_json,updated_at) VALUES (?,'complete',?,?)")
      .run('asset-960', JSON.stringify([{ corner: 'bottom_left', text: `${'ruido '.repeat(30)}277`, code: '277', hasWorld: false, worldUncertain: false }]), now);
    db.prepare("INSERT INTO image_inspections(media_asset_id,ocr_text,ocr_confidence,code_candidates_json,code_confidence,world_confidence,inspected_at) VALUES (?,'960 eS su',0.33,'[]',0,0,?)").run('asset-960', now);
    expect(readMarkDecision(db, 'asset-960', '960')).toMatchObject({ status: 'review', mode: null });
    db.prepare('UPDATE image_marking_state SET regions_json=? WHERE media_asset_id=?')
      .run(JSON.stringify([{ corner: 'top_left', text: '[960 A o', code: '960 A', hasWorld: true, worldUncertain: false }]), 'asset-960');
    expect(readMarkDecision(db, 'asset-960', '960')).toMatchObject({ status: 'ready', mode: 'original' });
    db.close();
  });

  it('añade solo lo que falta y detiene etiquetas conflictivas, separadas o dudosas', () => {
    expect(decideMarking('960', [], 'complete', null).mode).toBe('mark_all');
    expect(decideMarking('960', [label('960', false)], 'complete', null).mode).toBe('mark_world');
    expect(decideMarking('960', [label(null, true)], 'complete', null).mode).toBe('mark_code');
    expect(decideMarking('960', [label('999', true)], 'complete', null).status).toBe('review');
    expect(decideMarking('960', [label('960', false), label(null, true, 'top_right')], 'complete', null).status).toBe('review');
    expect(decideMarking('960', [{ ...label('960', false), worldUncertain: true }], 'complete', null).status).toBe('review');
    expect(decideMarking('960', [], 'running', null).status).toBe('pending');
    expect(decideMarking('960', [], 'failed', 'OCR no disponible').status).toBe('review');
  });

  it('analiza automáticamente después de recibir una foto sin detener la recepción', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenis-auto-inspect-'));
    directories.push(directory);
    const db = openDatabase(join(directory, 'business.sqlite'));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO supplier_profiles(id,session_id,source_group_id,name,margin_cop,marker_text,default_position,created_at,updated_at) VALUES ('provider','main','source@g.us','Bodega',10000,'🌍','top_left',?,?)").run(now, now);
    const inspector = { inspect: async (_source: Buffer): Promise<ImageInspection> => ({
      ocrText: '960 A', ocrConfidence: 0.95, ocrError: null, codeCandidates: [], detectedCode: null, detectedCodeConfidence: 0,
      world: { detected: true, variant: '🌍', confidence: 0.9, bounds: null }, regions: [label('960 A', true)],
    }) };
    const coordinator = new ImageInspectionCoordinator(db, directory, inspector);
    let job: Promise<void> | undefined;
    const ingestion = new SupplierIngestionService(db, directory, Fastify({ logger: false }).log, (assetId) => { job = coordinator.schedule(assetId); });
    const image = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await ingestion.receive({ groupId: 'source@g.us', messageId: 'automatic-mark', timestampMs: Date.now(), text: 'COD 960 $70.000', image: { bytes: image, mimeType: 'image/png' } });
    expect(job).toBeDefined();
    await job;
    expect(db.prepare('SELECT status,regions_json FROM image_marking_state').get()).toMatchObject({ status: 'complete', regions_json: expect.stringContaining('960 A') });
    await coordinator.close();
    db.close();
  });
});
