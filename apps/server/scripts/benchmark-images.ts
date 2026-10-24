import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../src/database.js';
import { ImageInspectionCoordinator } from '../src/image-inspection-coordinator.js';
import { ImageInspectorPool } from '../src/image-inspector-pool.js';
import { renderMarkedImage } from '../src/image-marking.js';
import { readMarkDecision } from '../src/image-marking-decision.js';

// Synthetic fixtures, not customer images. First use may download spa/eng OCR data.
const args = process.argv.slice(2);
const option = (name: string) => { const index=args.indexOf(name);return index >= 0 ? args[index+1] : undefined; };
const cache = resolve(option('--cache-dir') ?? join(tmpdir(), 'mincho-ocr-benchmark-cache'));
const directory = mkdtempSync(join(tmpdir(), 'mincho-image-benchmark-'));
mkdirSync(join(directory, 'media'));
const db = openDatabase(join(directory, 'business.sqlite'));
const pool = new ImageInspectorPool(cache, 2);
const coordinator = new ImageInspectionCoordinator(db,directory,pool);
const results: Array<Record<string,unknown>>=[];
try {
  const now=new Date().toISOString();
  db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('benchmark','Prueba sintética','COD 096-215','{}','needs_review',?,?,'main')").run(now,now);
  const original=await sharp({create:{width:640,height:480,channels:3,background:'#b6b0a8'}}).png().toBuffer();
  const marked=await renderMarkedImage(original,{code:'096-215',marker:'🌎',position:'bottom_right'});
  const fixtures=[{name:'sin etiqueta',bytes:original,expected:'mark_all'},
    {name:'código y mundo',bytes:marked.bytes,expected:'original'},
    {name:'etiqueta comprimida JPEG 55%',bytes:await sharp(marked.bytes).resize(480).jpeg({quality:55}).toBuffer(),expected:'original'},
    {name:'foto marcada repetida',bytes:marked.bytes,expected:'original'}];
  for (const position of ['top_left','top_right','bottom_left'] as const) {
    fixtures.push({ name: `código y mundo ${position}`, bytes: (await renderMarkedImage(original,{code:'096-215',marker:'🌎',position})).bytes, expected:'original' });
  }
  fixtures.push({name:'solo código',bytes:(await renderMarkedImage(original,{code:'096-215',marker:'🌎',position:'bottom_right',sourceHasWorld:true})).bytes,expected:'mark_world'});
  fixtures.push({name:'solo mundo',bytes:(await renderMarkedImage(original,{code:null,marker:'🌎',position:'bottom_right'})).bytes,expected:'mark_code'});
  fixtures.push({name:'código distinto al producto',bytes:(await renderMarkedImage(original,{code:'999-888',marker:'🌎',position:'bottom_right'})).bytes,expected:'review'});
  for(const [position,fixture] of fixtures.entries()) {
    const id=`fixture-${position}`;const hash=createHash('sha256').update(fixture.bytes).digest('hex');const name=`${hash}.png`;
    writeFileSync(join(directory,'media',name),fixture.bytes);
    db.prepare("INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,'benchmark',?,?,'image/png',?,?,?)").run(id,hash,name,fixture.bytes.length,position,now);
    const started=performance.now();await coordinator.schedule(id);const elapsedMs=Number((performance.now()-started).toFixed(2));
    const decision=readMarkDecision(db,id,'096-215');
    const record=db.prepare('SELECT engine_version,ocr_passes,cache_hit,ocr_error FROM image_inspections WHERE media_asset_id=?').get(id);
    results.push({fixture:fixture.name,elapsedMs,expected:fixture.expected,decision,record,passed:fixture.expected==='review' ? decision.status==='review' : decision.status==='ready' && decision.mode===fixture.expected});
  }
  const report={engine:coordinator.status('main'),fixtureType:'synthetic',results,passed:results.every(r=>r.passed)};
  const output=option('--output');if(output)writeFileSync(resolve(output),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
} finally { await coordinator.close();db.close();rmSync(directory,{recursive:true,force:true}); }
