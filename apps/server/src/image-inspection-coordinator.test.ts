import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.js';
import { ImageInspectionCoordinator } from './image-inspection-coordinator.js';
import type { ImageInspection } from './image-inspection.js';
import type { ImageInspector } from './image-engine.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path,{recursive:true,force:true}); });
const result = (): ImageInspection => ({ ocrText:'COD 960',ocrConfidence:0.9,ocrError:null,codeCandidates:[],detectedCode:'960',detectedCodeConfidence:0.9,
  world:{detected:false,variant:null,confidence:0,bounds:null},regions:[{corner:'top_left',text:'960',code:'960',hasWorld:false,worldUncertain:false}],metrics:{durationMs:12,ocrPasses:9} });
function setup(inspector: ImageInspector) {
  const directory=mkdtempSync(join(tmpdir(),'mincho-image-queue-')); directories.push(directory);
  mkdirSync(join(directory,'media'));
  const db=openDatabase(join(directory,'business.sqlite')); const now=new Date().toISOString();
  db.prepare("INSERT INTO products(id,title,raw_text,analysis_json,status,created_at,updated_at,session_id) VALUES ('product','Tenis','COD 960','{}','needs_review',?,?,'main')").run(now,now);
  let position=0;
  function asset(id: string, bytes=Buffer.from('same photo')) {
    const hash=createHash('sha256').update(bytes).digest('hex'); const name=`${hash}.png`;writeFileSync(join(directory,'media',name),bytes);
    db.prepare("INSERT INTO media_assets(id,product_id,sha256,file_name,mime_type,size_bytes,position,created_at) VALUES (?,'product',?,?,'image/png',?,?,?)").run(id,hash,name,bytes.length,position++,now);
  }
  return {db,directory,asset,coordinator:new ImageInspectionCoordinator(db,directory,inspector)};
}
function deferred<T>() { let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}; }

// No OCR downloads: deterministic inspectors exercise persistence, scheduling and recovery.
describe('image engine queue and cache',()=>{
  it('shares an identical in-flight photo, keeps manual choices per asset, and persists reuse across restarts',async()=>{
    let calls=0;const gate=deferred<ImageInspection>();const entered=deferred<void>();
    const inspector={concurrency:2,version:'test-v1',inspect:async()=>{calls++;entered.resolve();return gate.promise;}};
    const {db,directory,asset,coordinator}=setup(inspector);asset('a');asset('b');
    const a=coordinator.schedule('a');const b=coordinator.schedule('b');
    expect(coordinator.schedule('a')).toBe(a);
    db.prepare("UPDATE image_marking_state SET manual_mode='original' WHERE media_asset_id='b'").run();
    await entered.promise;gate.resolve(result());await Promise.all([a,b]);
    expect(calls).toBe(1);
    expect(db.prepare('SELECT media_asset_id,manual_mode FROM image_marking_state ORDER BY media_asset_id').all()).toEqual([{media_asset_id:'a',manual_mode:null},{media_asset_id:'b',manual_mode:'original'}]);
    expect(db.prepare("SELECT cache_hit,ocr_passes,engine_version FROM image_inspections WHERE media_asset_id='b'").get()).toEqual({cache_hit:1,ocr_passes:0,engine_version:'test-v1'});
    await coordinator.close();asset('c');
    const restarted=new ImageInspectionCoordinator(db,directory,{version:'test-v1',inspect:async()=>{throw Error('cache expected');}});
    await restarted.schedule('c');expect(db.prepare("SELECT cache_hit FROM image_inspections WHERE media_asset_id='c'").get()).toEqual({cache_hit:1});
    await restarted.close();db.close();
  });
  it('bounds parallel work and advances waiting photos after completion',async()=>{
    let active=0,maxActive=0,calls=0;const gates=Array.from({length:3},()=>deferred<ImageInspection>());const entered=[deferred<void>(),deferred<void>(),deferred<void>()];
    const {db,asset,coordinator}=setup({concurrency:2,inspect:async()=>{const n=calls++;active++;maxActive=Math.max(active,maxActive);entered[n]!.resolve();try{return await gates[n]!.promise;}finally{active--;}}});
    for(const id of ['a','b','c'])asset(id,Buffer.from(id));
    const jobs=['a','b','c'].map(id=>coordinator.schedule(id));
    await Promise.all([entered[0]!.promise,entered[1]!.promise]);expect(calls).toBe(2);
    gates[0]!.resolve(result());await entered[2]!.promise;gates[1]!.resolve(result());gates[2]!.resolve(result());await Promise.all(jobs);
    expect(maxActive).toBe(2);expect(calls).toBe(3);await coordinator.close();db.close();
  });
  it('forces a real reanalysis, invalidates older engine results, and keeps manual overrides',async()=>{
    let calls=0;const inspector={version:'v1',inspect:async()=>{calls++;return result();}};
    const {db,directory,asset,coordinator}=setup(inspector);asset('a');await coordinator.schedule('a');await coordinator.schedule('a');expect(calls).toBe(1);
    db.prepare("UPDATE image_marking_state SET manual_mode='mark_world' WHERE media_asset_id='a'").run();
    await coordinator.schedule('a',true);expect(calls).toBe(2);await coordinator.close();
    const upgraded=new ImageInspectionCoordinator(db,directory,{version:'v2',inspect:inspector.inspect});upgraded.resume();await upgraded.close();
    expect(calls).toBe(3);expect(db.prepare("SELECT engine_version,cache_hit FROM image_inspections WHERE media_asset_id='a'").get()).toEqual({engine_version:'v2',cache_hit:0});
    expect(db.prepare("SELECT manual_mode FROM image_marking_state WHERE media_asset_id='a'").get()).toEqual({manual_mode:'mark_world'});db.close();
  });
  it('does not cache OCR errors and continues to analyze later photos',async()=>{
    let calls=0;const {db,asset,coordinator}=setup({inspect:async()=>{calls++;return calls===1?{...result(),ocrError:'OCR failed'}:result();}});
    asset('a');asset('b');await coordinator.schedule('a');expect(db.prepare('SELECT COUNT(*) as n FROM image_analysis_cache').get()).toEqual({n:0});
    await coordinator.schedule('b');expect(calls).toBe(2);expect(db.prepare("SELECT status FROM image_marking_state WHERE media_asset_id='b'").get()).toEqual({status:'complete'});await coordinator.close();db.close();
  });
  it('does not recreate deleted photos or leave their OCR results cached after a late response',async()=>{
    const entered=deferred<void>(),gate=deferred<ImageInspection>();const {db,asset,coordinator}=setup({inspect:async()=>{entered.resolve();return gate.promise;}});
    asset('a');const job=coordinator.schedule('a');await entered.promise;db.prepare("DELETE FROM media_assets WHERE id='a'").run();gate.resolve(result());await job;
    expect(db.prepare('SELECT COUNT(*) as n FROM image_inspections').get()).toEqual({n:0});expect(db.prepare('SELECT COUNT(*) as n FROM image_analysis_cache').get()).toEqual({n:0});await coordinator.close();db.close();
  });
  it('leaves waiting photos pending at shutdown and resumes them on restart',async()=>{
    const gate=deferred<ImageInspection>(),entered=deferred<void>();
    const {db,directory,asset,coordinator}=setup({version:'v1',inspect:async()=>{entered.resolve();return gate.promise;}});
    asset('a',Buffer.from('a'));asset('b',Buffer.from('b'));asset('c',Buffer.from('c'));
    const jobs=['a','b','c'].map(id=>coordinator.schedule(id));await entered.promise;
    const closing=coordinator.close();gate.resolve(result());await closing;await Promise.all(jobs);
    expect(db.prepare('SELECT media_asset_id,status FROM image_marking_state ORDER BY media_asset_id').all()).toEqual([{media_asset_id:'a',status:'complete'},{media_asset_id:'b',status:'pending'},{media_asset_id:'c',status:'pending'}]);
    let calls=0;const resumed=new ImageInspectionCoordinator(db,directory,{version:'v1',inspect:async()=>{calls++;return result();}});
    resumed.resume();await resumed.schedule('b');await resumed.schedule('c');expect(calls).toBe(2);await resumed.close();db.close();
  });
  it('removes cached OCR only when the last identical original is deleted',async()=>{
    const {db,asset,coordinator}=setup({inspect:async()=>result()});asset('a');asset('b');await coordinator.schedule('a');
    db.prepare("DELETE FROM media_assets WHERE id='a'").run();expect(db.prepare('SELECT COUNT(*) as n FROM image_analysis_cache').get()).toEqual({n:1});
    db.prepare("DELETE FROM media_assets WHERE id='b'").run();expect(db.prepare('SELECT COUNT(*) as n FROM image_analysis_cache').get()).toEqual({n:0});await coordinator.close();db.close();
  });
});
