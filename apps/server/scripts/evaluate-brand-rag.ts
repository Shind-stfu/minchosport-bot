import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.js';
import { resolveDataDirectoryOptions } from '../src/data-directory.js';
import { ImageBrandInspector, type ImageInferenceDevice } from '../src/image-brand-inspection.js';
import { indexRagReferences, indexedReferences, matchShoes, ragCatalog, ragDevice } from '../src/brand-rag.js';
import { calibrateRag, calibrationPartition, type RagTrial } from '../src/rag-calibration.js';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const { values } = parseArgs({ options: { db: {type:'string'}, media: {type:'string'}, cache: {type:'string'},
  session: {type:'string', default:'main'}, device: {type:'string', default:process.env.IMAGE_INFERENCE_DEVICE ?? 'auto'} } });
const dir = resolveDataDirectoryOptions({appMode: process.env.APP_MODE === 'experimental' ? 'experimental' : 'simulation',
  ...(process.env.DATA_DIR ? {dataDir:process.env.DATA_DIR} : {})}).dataDirectory;
const dbFile = values.db ?? join(dir, 'business.sqlite');
if (!existsSync(dbFile)) throw Error('No se encontró la base de datos. Indica --db.');
const media = values.media ?? join(dirname(dbFile), 'media');
const cache = values.cache ?? [join(dirname(dir),'models'),join(dirname(dirname(dir)),'models')].find(p => existsSync(join(p,'qwen3.5'))) ?? join(dirname(dir),'models');
if (!['auto','cpu','gpu','webgpu','dml'].includes(values.device)) throw Error('Dispositivo inválido.');
const db = openDatabase(dbFile);
const inspector = new ImageBrandInspector(join(cache,'florence-qwen'), 3600000, values.device as ImageInferenceDevice);
async function timed<T>(run: () => Promise<T>) {
  let peak = process.memoryUsage.rss();
  const poll = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 100);
  const start = performance.now();
  try { const value = await run(); return { value, ms: performance.now()-start, rss: Math.max(peak,process.memoryUsage.rss()) }; }
  finally { clearInterval(poll); }
}
try {
  const catalog = ragCatalog(db, values.session);
  const errors = await indexRagReferences(db, media, catalog.groups, bytes => inspector.embedShoes(bytes));
  const {indexed, missing} = indexedReferences(db, catalog.groups);
  const trials: RagTrial[] = [];
  const excluded = catalog.groups.filter(g => g.conflict).length;
  const candidates = (db.prepare('SELECT display_name brand FROM shoe_brand_registry').all() as {brand:string}[]).map(r=>r.brand);
  for (const group of catalog.groups.filter(g => g.reserved && !g.conflict)) {
    const photo = group.photos.find(p => p.split === 'holdout')!;
    try {
      const bytes = await readFile(join(media,photo.file));
      const retrieval = await timed(async () => matchShoes(await inspector.embedShoes(bytes),indexed));
      const baseline = await timed(() => inspector.inspect(bytes,candidates,{captionCandidates:[],ocrCandidates:[]}));
      if (baseline.value.evidence.visualError) throw Error(baseline.value.evidence.visualError);
      trials.push({ key:group.key, expected:group.brand, match:retrieval.value, baseline:baseline.value.suggestedBrand,
        retrievalMs:retrieval.ms, baselineMs:baseline.ms, retrievalRss:retrieval.rss, baselineRss:baseline.rss });
      console.error(`Evaluada ${photo.id} (${trials.length})`);
    } catch (e) { errors.push(`${photo.id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const report = calibrateRag(trials);
  if (missing || errors.length || catalog.fingerprint !== ragCatalog(db,values.session).fingerprint) {
    report.policy.brands = [];
    report.calibratedSkips = 0;
  }
  db.prepare('INSERT OR REPLACE INTO brand_rag_calibration VALUES (?,?,?)')
    .run(ragDevice(values.device) + ':' + catalog.fingerprint,catalog.fingerprint,JSON.stringify(report.policy));
  console.log(JSON.stringify({indexedGroups:indexed.length, missingReferences:missing, conflictingGroups:excluded, errors,
    peakProcessRssBytes:process.resourceUsage().maxRSS*1024, ...report, photos:trials.map(t => ({...t,partition:calibrationPartition(t.key)}))},null,2));
} finally { await inspector.close(); db.close(); }
