import { createHash } from 'node:crypto';
import { cpus, hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDatabase } from './database.js';
import { normalizeBrandName } from './brand-candidates.js';
import { cosineSimilarity } from './solematch-clip.js';
import { BRAND_MODEL_ID, type ImageBrandInspection } from './image-brand-inspection.js';
import { RAG_ENCODER } from './rag-version.js';

export type RagMode = 'off' | 'exact' | 'shadow' | 'trial' | 'auto';
export type RagEvidence = NonNullable<ImageBrandInspection['evidence']['retrieval']>;
export type RagPolicy = { score: number; margin: number; brands: string[] };
export const defaultThresholds = { score: 0.8, margin: 0.04 };
export function ragDevice(device: string) {
  return JSON.stringify([hostname(), process.platform, process.arch, cpus()[0]?.model, device]);
}

type Photo = { id: string; sha: string; file: string; product: string; supplier: string | null;
  code: string | null; brand: string | null; split: 'reference' | 'holdout' | null };
export type RagGroup = { key: string; photos: Photo[]; reserved: boolean; conflict: boolean; brand: string | null };
function referenceBrand(brand: string | null) {
  const normalized = normalizeBrandName(brand ?? '');
  if (normalized === 'multimarca') return null;
  if (normalized === 'on' || normalized === 'on cloud') return 'ON CLOUD';
  return brand;
}
export function ragCatalog(db: AppDatabase, session: string) {
  const rows = db.prepare(`SELECT m.id,m.sha256 sha,m.file_name file,m.product_id product,p.supplier_id supplier,
    p.shoe_code code,l.expected_brand brand,l.split FROM media_assets m JOIN products p ON p.id=m.product_id
    LEFT JOIN shoe_brand_labels l ON l.media_asset_id=m.id WHERE p.session_id=? ORDER BY m.id`).all(session) as Photo[];
  // Connected components also catch a resend that links two different product codes.
  const parents = new Map<string, string>();
  function root(key: string): string {
    let parent = parents.get(key);
    while (parent && parent !== key) {
      const next = parents.get(parent) ?? parent;
      parents.set(key, next);
      key = parent;
      parent = next;
    }
    return key;
  }
  for (const row of rows) {
    const keys = ['sha:' + row.sha, 'product:' + row.product];
    if (row.supplier && row.code?.trim()) keys.push(JSON.stringify([row.supplier, row.code.trim().toUpperCase()]));
    const first = root(keys[0]!);
    for (const key of keys.slice(1)) parents.set(root(key), first);
  }
  const groups = new Map<string, RagGroup>();
  const byPhoto = new Map<string, RagGroup>();
  for (const row of rows) {
    const key = root('sha:' + row.sha);
    const group = groups.get(key) ?? { key, photos: [], reserved: false, conflict: false, brand: null };
    group.photos.push(row);
    groups.set(key, group);
    byPhoto.set(row.id, group);
  }
  for (const group of groups.values()) {
    const labels = group.photos.filter(photo => photo.split);
    group.reserved = labels.some(photo => photo.split === 'holdout');
    group.brand = referenceBrand(labels[0]?.brand ?? null);
    group.conflict = labels.some(photo => normalizeBrandName(referenceBrand(photo.brand) ?? '') !== normalizeBrandName(group.brand ?? ''));
    // A stable identifier for partitioning, even when an unlabelled repost arrives.
    group.key = labels.map(photo => photo.sha).sort()[0] ?? group.key;
  }
  const verified = [...groups.values()].filter(group => group.photos.some(photo => photo.split));
  const fingerprint = createHash('sha256').update(JSON.stringify([RAG_ENCODER, BRAND_MODEL_ID, session,
    verified.map(group => [group.key, group.reserved, group.conflict, group.brand,
      group.photos.filter(p => p.split).map(p => [p.sha, p.split, p.brand]).sort()]).sort()])).digest('hex');
  return { byPhoto, groups: verified, fingerprint };
}

export function exactBrand(group: RagGroup, id: string, sha: string) {
  if (group.conflict || group.reserved || !group.brand) return null;
  return group.photos.some(p => p.id !== id && p.sha === sha && p.split === 'reference') ? group.brand : null;
}

export type IndexedGroup = { brand: string; key: string; vectors: number[][] };
export function indexedReferences(db: AppDatabase, groups: RagGroup[]) {
  const lookup = db.prepare('SELECT vectors_json FROM brand_rag_vectors WHERE sha256=? AND encoder=?');
  const indexed: IndexedGroup[] = [];
  let missing = 0;
  for (const group of groups) {
    if (!group.brand || group.conflict || group.reserved) continue;
    const vectors: number[][] = [];
    for (const sha of new Set(group.photos.filter(p => p.split === 'reference').map(p => p.sha))) {
      const row = lookup.get(sha, RAG_ENCODER) as {vectors_json: string} | undefined;
      if (row) vectors.push(...JSON.parse(row.vectors_json) as number[][]);
      else missing++;
    }
    if (vectors.length) indexed.push({ key: group.key, brand: group.brand, vectors });
  }
  return { indexed, missing };
}

export type RagMatch = { brand: string; score: number; margin: number; supportCount?: number };
// Each product gets one vote regardless of the number of photos or crops it contributed.
export function matchShoes(shoes: number[][], references: IndexedGroup[]): RagMatch | null {
  if (!shoes.length) return null;
  const matches: RagMatch[] = [];
  for (const shoe of shoes) {
    const scores = new Map<string, { brand: string; scores: number[] }>();
    for (const ref of references) {
      const key = normalizeBrandName(ref.brand);
      const entry = scores.get(key) ?? { brand: ref.brand, scores: [] };
      entry.scores.push(Math.max(...ref.vectors.map(v => cosineSimilarity(shoe, v))));
      scores.set(key, entry);
    }
    const ranked = [...scores.values()].map(({brand, scores}) => {
      const top = scores.sort((a,b) => b-a).slice(0,3);
      return { brand, support: top.length, score: top.reduce((a,b) => a+b, 0) / top.length };
    }).sort((a,b) => b.score - a.score);
    const [winner, next] = ranked;
    if (!winner || !next || winner.support < 3) return null;
    matches.push({brand: winner.brand, score: winner.score, margin: winner.score-next.score});
  }
  if (matches.some(m => m.brand !== matches[0]!.brand)) return null;
  return {brand: matches[0]!.brand, score: Math.min(...matches.map(m => m.score)), margin: Math.min(...matches.map(m => m.margin))};
}

/** Experimental nearest-neighbor mode: always returns the closest available brand, including ties and small catalogs. */
export function matchShoesTrial(shoes: number[][], references: IndexedGroup[]): RagMatch | null {
  if (!shoes.length || !references.length) return null;
  const brands = new Map<string, { brand: string; scores: number[]; support: Set<string> }>();
  for (const shoe of shoes) {
    const scores = new Map<string, { brand: string; references: Array<{ key: string; score: number }> }>();
    for (const reference of references) {
      const key = normalizeBrandName(reference.brand);
      const entry = scores.get(key) ?? { brand: reference.brand, references: [] };
      entry.references.push({ key: reference.key, score: Math.max(...reference.vectors.map(vector => cosineSimilarity(shoe, vector))) });
      scores.set(key, entry);
    }
    for (const [key, entry] of scores) {
      const top = entry.references.sort((a, b) => b.score - a.score).slice(0, 3);
      const brand = brands.get(key) ?? { brand: entry.brand, scores: [], support: new Set<string>() };
      brand.scores.push(top.reduce((sum, reference) => sum + reference.score, 0) / top.length);
      for (const reference of top) brand.support.add(reference.key);
      brands.set(key, brand);
    }
  }
  const ranked = [...brands.values()].map(entry => ({
    brand: entry.brand,
    score: entry.scores.reduce((sum, score) => sum + score, 0) / entry.scores.length,
    supportCount: entry.support.size,
  })).sort((a, b) => b.score - a.score);
  const [winner, runnerUp] = ranked;
  if (!winner) return null;
  return { ...winner, margin: winner.score - (runnerUp?.score ?? 0) };
}

export function qualifies(match: RagMatch | null, limits: typeof defaultThresholds): match is RagMatch {
  return !!match && match.score >= limits.score && match.margin >= limits.margin;
}

export async function indexRagReferences(db: AppDatabase, mediaDir: string, groups: RagGroup[],
  embed: (source: Buffer) => Promise<number[][]>, stopping = () => false) {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cached = db.prepare('SELECT 1 FROM brand_rag_vectors WHERE sha256=? AND encoder=?');
  const save = db.prepare(`INSERT OR IGNORE INTO brand_rag_vectors SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM media_assets WHERE sha256=?)`);
  for (const group of groups) {
    if (!group.brand || group.reserved || group.conflict) continue;
    for (const photo of group.photos) {
      if (stopping()) return errors;
      if (photo.split !== 'reference' || seen.has(photo.sha) || cached.get(photo.sha, RAG_ENCODER)) continue;
      seen.add(photo.sha);
      try {
        const vectors = await embed(await readFile(join(mediaDir, photo.file)));
        save.run(photo.sha, RAG_ENCODER, JSON.stringify(vectors), photo.sha);
      } catch (e) {
        errors.push(`${photo.id}: ${e instanceof Error ? e.message : String(e)}`);
        // A missing image is local to one entry. A failing encoder affects every subsequent entry.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return errors;
      }
    }
  }
  return errors;
}

export function readPolicy(db: AppDatabase, device: string, fingerprint: string) {
  const row = db.prepare('SELECT policy_json FROM brand_rag_calibration WHERE device=? AND fingerprint=?')
    .get(device + ':' + fingerprint, fingerprint) as { policy_json: string } | undefined;
  return row ? JSON.parse(row.policy_json) as RagPolicy : null;
}
