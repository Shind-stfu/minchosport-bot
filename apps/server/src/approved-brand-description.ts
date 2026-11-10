import { descriptionContainsBrand, prependBrandBeforeShoeCode } from '@tenis/core';
import { detectJordanBrandSignal, normalizeBrandName, resolveVisionBrandConsensus } from './brand-candidates.js';
import { BRAND_MODEL_ID } from './image-brand-inspection.js';
import type { AppDatabase } from './database.js';

/** Canonicalize model typos/aliases in persisted inference data and unsent drafts. */
export function reconcileRegisteredBrandAliases(db: AppDatabase, now = new Date().toISOString()) {
  const registered = db.prepare('SELECT normalized_name as normalizedName,display_name as displayName,aliases_json as aliasesJson FROM shoe_brand_registry')
    .all() as Array<{ normalizedName: string; displayName: string; aliasesJson: string }>;
  const canonicalBrands = new Map(registered.map((brand) => [brand.normalizedName, brand.displayName]));
  const aliases = new Map<string, { normalizedName: string; displayName: string; alias: string }>();
  for (const brand of registered) {
    let names: string[] = [];
    try { names = JSON.parse(brand.aliasesJson) as string[]; } catch { /* Ignore a damaged alias list. */ }
    for (const alias of names) {
      const normalizedAlias = normalizeBrandName(alias);
      if (normalizedAlias && normalizedAlias !== brand.normalizedName) aliases.set(normalizedAlias, { normalizedName: brand.normalizedName, displayName: brand.displayName, alias });
    }
  }
  if (!aliases.size) return { inspections: 0, labels: 0, drafts: 0 };

  const replacements = [...aliases.values()].sort((a, b) => b.alias.length - a.alias.length).map((entry) => ({
    ...entry,
    pattern: new RegExp(entry.alias.trim().split(/\s+/u).map(escapeRegExp).join('\\s+'), 'giu'),
  }));
  const canonicalizeText = (text: string) => {
    let result = text;
    for (const replacement of replacements) result = result.replace(replacement.pattern, (match) => preserveBrandCase(match, replacement.displayName));
    return result;
  };
  const canonicalizeName = (name: string | null) => name === null ? null
    : aliases.get(normalizeBrandName(name))?.displayName ?? canonicalBrands.get(normalizeBrandName(name)) ?? name;
  const canonicalizeJson = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return ['visualAnswer', 'visualLogoText', 'visualEvidence'].includes(key) ? value : canonicalizeName(value);
    if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, canonicalizeJson(item, childKey)]));
    return value;
  };

  let inspections = 0;
  let labels = 0;
  let drafts = 0;
  const jordanBrand = aliases.get(normalizeBrandName('JUMPMAN'))?.displayName;
  db.transaction(() => {
    const inspectionRows = db.prepare(`SELECT media_asset_id as assetId,suggested_brand as suggestedBrand,confirmed_brand as confirmedBrand,
      candidates_json as candidatesJson,evidence_json as evidenceJson,status,auto_eligible as autoEligible,manual_override as manualOverride,reason
      FROM image_brand_inspections`).all() as Array<{
        assetId: string; suggestedBrand: string | null; confirmedBrand: string | null; candidatesJson: string; evidenceJson: string;
        status: string; autoEligible: number; manualOverride: number; reason: string;
      }>;
    const updateInspection = db.prepare(`UPDATE image_brand_inspections SET suggested_brand=?,confirmed_brand=?,candidates_json=?,evidence_json=?,
      status=?,auto_eligible=?,reason=? WHERE media_asset_id=?`);
    for (const row of inspectionRows) {
      let candidates = row.candidatesJson;
      let evidence = row.evidenceJson;
      try { candidates = JSON.stringify(canonicalizeJson(JSON.parse(candidates))); } catch { /* Keep malformed JSON intact. */ }
      let evidenceValue: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(evidence) as unknown;
        evidenceValue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
      } catch { /* Keep malformed JSON intact. */ }
      let suggested = row.suggestedBrand === null ? null : canonicalizeText(row.suggestedBrand);
      let confirmed = row.confirmedBrand === null ? null : canonicalizeText(row.confirmedBrand);
      let status = row.status;
      let autoEligible = row.autoEligible;
      let reason = canonicalizeText(row.reason);
      if (evidenceValue) {
        const visionConsensus = resolveVisionBrandConsensus(
          typeof evidenceValue.visualAnswer === 'string' ? evidenceValue.visualAnswer : '',
          typeof evidenceValue.visualLogoText === 'string' ? evidenceValue.visualLogoText : '',
        );
        if (visionConsensus.brand && !row.manualOverride && row.status !== 'confirmed'
          && (!evidenceValue.visualBrand || !suggested)) {
          const consensusBrand = canonicalizeName(visionConsensus.brand)!;
          const otherBrand = [evidenceValue.visualBrand, suggested].find((value): value is string => typeof value === 'string'
            && normalizeBrandName(value) !== normalizeBrandName(consensusBrand));
          evidenceValue.visualBrand = consensusBrand;
          if (visionConsensus.disagreement || otherBrand) evidenceValue.brandConflict = true;
          suggested = consensusBrand;
          confirmed = null;
          status = 'review';
          autoEligible = 0;
          reason = visionConsensus.disagreement
            ? `Florence + Qwen leyó ${consensusBrand} en ${visionConsensus.votes} de ${visionConsensus.totalVotes} respuestas; una lectura discrepa y requiere revisión.`
            : `Florence + Qwen coincide en ${consensusBrand} en ${visionConsensus.totalVotes} lecturas.`;
        }
        const jordanSignal = detectJordanBrandSignal([evidenceValue.visualLogoText, evidenceValue.visualEvidence, evidenceValue.visualAnswer]
          .filter((value): value is string => typeof value === 'string'));
        if (jordanSignal && jordanBrand && !row.manualOverride) {
          const otherBrand = [evidenceValue.visualBrand, suggested].find((value): value is string => typeof value === 'string'
            && normalizeBrandName(value) !== normalizeBrandName(jordanBrand));
          evidenceValue.visualBrand = jordanBrand;
          if (otherBrand) evidenceValue.brandConflict = true;
          suggested = jordanBrand;
          confirmed = null;
          status = 'review';
          autoEligible = 0;
          const sourceName = jordanSignal === 'jumpman' ? 'El logo Jumpman' : 'La marca Jordan';
          reason = otherBrand
            ? `${sourceName} se asocia con Jordan; otra señal propuso ${otherBrand}, así que queda para revisión.`
            : `${sourceName} fue identificado en la zapatilla.`;
        }
        evidence = JSON.stringify(canonicalizeJson(evidenceValue));
      }
      if (suggested !== row.suggestedBrand || confirmed !== row.confirmedBrand || candidates !== row.candidatesJson || evidence !== row.evidenceJson
        || status !== row.status || autoEligible !== row.autoEligible || reason !== row.reason) {
        updateInspection.run(suggested, confirmed, candidates, evidence, status, autoEligible, reason, row.assetId);
        inspections += 1;
      }
    }

    const updateLabel = db.prepare('UPDATE shoe_brand_labels SET expected_brand=? WHERE media_asset_id=?');
    const labelRows = db.prepare('SELECT media_asset_id as assetId,expected_brand as expectedBrand FROM shoe_brand_labels WHERE expected_brand IS NOT NULL').all() as Array<{ assetId: string; expectedBrand: string }>;
    for (const row of labelRows) {
      const brand = canonicalizeName(row.expectedBrand)!;
      if (brand !== row.expectedBrand) { updateLabel.run(brand, row.assetId); labels += 1; }
    }
    const updateSample = db.prepare(`UPDATE shoe_brand_evaluation_samples SET predicted_brand=?,expected_brand=?,source_predictions_json=? WHERE media_asset_id=?`);
    const sampleRows = db.prepare(`SELECT media_asset_id as assetId,predicted_brand as predictedBrand,expected_brand as expectedBrand,
      source_predictions_json as sourcePredictionsJson FROM shoe_brand_evaluation_samples`).all() as Array<{
        assetId: string; predictedBrand: string | null; expectedBrand: string | null; sourcePredictionsJson: string;
      }>;
    for (const row of sampleRows) {
      let predictions = row.sourcePredictionsJson;
      try { predictions = JSON.stringify(canonicalizeJson(JSON.parse(predictions))); } catch { /* Keep malformed JSON intact. */ }
      const predicted = row.predictedBrand === null ? null : canonicalizeText(row.predictedBrand);
      const expected = row.expectedBrand === null ? null : canonicalizeName(row.expectedBrand);
      if (predicted !== row.predictedBrand || expected !== row.expectedBrand || predictions !== row.sourcePredictionsJson) {
        updateSample.run(predicted, expected, predictions, row.assetId);
        labels += 1;
      }
    }

    const referenceRows = db.prepare('SELECT normalized_brand as normalizedBrand,media_asset_id as assetId FROM shoe_brand_references').all() as Array<{ normalizedBrand: string; assetId: string }>;
    const copyReference = db.prepare(`INSERT OR IGNORE INTO shoe_brand_references(normalized_brand,media_asset_id,created_at)
      SELECT ?,media_asset_id,created_at FROM shoe_brand_references WHERE normalized_brand=? AND media_asset_id=?`);
    const deleteReference = db.prepare('DELETE FROM shoe_brand_references WHERE normalized_brand=? AND media_asset_id=?');
    for (const row of referenceRows) {
      const canonical = aliases.get(normalizeBrandName(row.normalizedBrand));
      if (canonical) {
        copyReference.run(canonical.normalizedName, row.normalizedBrand, row.assetId);
        deleteReference.run(row.normalizedBrand, row.assetId);
      }
    }

    const products = db.prepare(`SELECT p.id,p.output_text as outputText FROM products p
      WHERE p.output_text IS NOT NULL AND p.status IN ('approved','simulated')
        AND NOT EXISTS (SELECT 1 FROM outbound_publications o WHERE o.product_id=p.id
          AND o.status IN ('queued','in_progress','submitted','needs_review'))`).all() as Array<{ id: string; outputText: string }>;
    const updateProduct = db.prepare('UPDATE products SET output_text=?,updated_at=? WHERE id=?');
    for (const product of products) {
      const outputText = canonicalizeText(product.outputText);
      if (outputText !== product.outputText) { updateProduct.run(outputText, now, product.id); drafts += 1; }
    }
  })();
  return { inspections, labels, drafts };
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

function preserveBrandCase(match: string, canonicalName: string) {
  if (match === match.toLocaleUpperCase('es')) return canonicalName.toLocaleUpperCase('es');
  if (match === match.toLocaleLowerCase('es')) return canonicalName.toLocaleLowerCase('es');
  return canonicalName;
}

/** Add a confirmed brand to an approved, not-yet-published description. */
export function applyConfirmedBrandToApprovedDescription(db: AppDatabase, productId: string, brand: string, now = new Date().toISOString()) {
  return applyBrandToApprovedDescription(db, productId, brand, now, false);
}

/** Add the primary Florence + Qwen suggestion to an unsent description draft. */
export function applyPrimaryVisionBrandToApprovedDescription(db: AppDatabase, productId: string, brand: string, now = new Date().toISOString()) {
  return applyBrandToApprovedDescription(db, productId, brand, now, true);
}

/** Backfill already-analyzed approved drafts when this pipeline version starts. */
export function reconcilePrimaryVisionBrandDescriptions(db: AppDatabase, now = new Date().toISOString()) {
  const rows = db.prepare(`SELECT p.id as productId,b.suggested_brand as suggestedBrand,b.evidence_json as evidence
    FROM products p JOIN media_assets m ON m.product_id=p.id JOIN image_brand_inspections b ON b.media_asset_id=m.id
    WHERE p.status IN ('needs_review','approved','simulated') AND b.model_id=? AND b.status='review'
      AND NOT EXISTS (SELECT 1 FROM outbound_publications o WHERE o.product_id=p.id AND o.status IN ('queued','in_progress','submitted','needs_review'))`)
    .all(BRAND_MODEL_ID) as Array<{ productId: string; suggestedBrand: string | null; evidence: string }>;
  const processed = new Set<string>();
  let updated = 0;
  for (const row of rows) {
    if (processed.has(row.productId) || !row.suggestedBrand) continue;
    try {
      const evidence = JSON.parse(row.evidence) as { visualBrand?: string | null };
      if (!evidence.visualBrand || normalizeBrandName(evidence.visualBrand) !== normalizeBrandName(row.suggestedBrand)) continue;
      processed.add(row.productId);
      if (applyPrimaryVisionBrandToApprovedDescription(db, row.productId, evidence.visualBrand, now)) updated += 1;
    } catch { /* Ignore corrupt evidence; the catalogue keeps its current description. */ }
  }
  return updated;
}

function applyBrandToApprovedDescription(db: AppDatabase, productId: string, brand: string, now: string, usePrimaryVision: boolean) {
  const product = db.prepare(`SELECT id,status,raw_text as rawText,output_text as outputText,shoe_code as shoeCode FROM products WHERE id=?`)
    .get(productId) as { id: string; status: string; rawText: string; outputText: string | null; shoeCode: string | null } | undefined;
  const allowedStatuses = usePrimaryVision ? ['needs_review', 'approved', 'simulated'] : ['approved', 'simulated'];
  if (!product || !allowedStatuses.includes(product.status) || !product.outputText) return false;
  if (db.prepare("SELECT 1 FROM outbound_publications WHERE product_id=? AND status IN ('queued','in_progress','submitted','needs_review') LIMIT 1").get(productId)) return false;
  if (!brand.trim()) return false;

  const photos = db.prepare(`SELECT b.model_id as modelId,b.status,b.confirmed_brand as confirmedBrand,b.suggested_brand as suggestedBrand,b.evidence_json as evidence,b.manual_override as manualOverride
    FROM media_assets m LEFT JOIN image_brand_inspections b ON b.media_asset_id=m.id WHERE m.product_id=?`).all(productId) as Array<{
      modelId: string | null; status: string | null; confirmedBrand: string | null; suggestedBrand: string | null; evidence: string | null; manualOverride: number | null;
    }>;
  if (!photos.length) return false;
  const expected = normalizeBrandName(brand);
  let hasPrimaryVisionSuggestion = false;
  const registeredBrands = db.prepare('SELECT display_name as displayName,aliases_json as aliasesJson FROM shoe_brand_registry')
    .all() as Array<{ displayName: string; aliasesJson: string }>;
  for (const photo of photos) {
    if (!photo.status || photo.status === 'pending' || photo.status === 'failed') return false;
    if (photo.manualOverride && !photo.confirmedBrand) return false;
    if (photo.confirmedBrand && normalizeBrandName(photo.confirmedBrand) !== expected) return false;
    if (photo.status === 'review' && photo.suggestedBrand && normalizeBrandName(photo.suggestedBrand) !== expected) return false;
    if (usePrimaryVision && photo.modelId !== BRAND_MODEL_ID) return false;
    try {
      const evidence = JSON.parse(photo.evidence ?? '{}') as { brandConflict?: boolean; visualBrand?: string | null };
      if (usePrimaryVision) {
        if (evidence.visualBrand && normalizeBrandName(evidence.visualBrand) !== expected) return false;
        if (evidence.visualBrand && normalizeBrandName(evidence.visualBrand) === expected) hasPrimaryVisionSuggestion = true;
        if (evidence.brandConflict && !photo.manualOverride && normalizeBrandName(evidence.visualBrand ?? '') !== expected) return false;
      } else if (evidence.brandConflict && !photo.manualOverride) return false;
    } catch { return false; }
  }
  if (usePrimaryVision && !hasPrimaryVisionSuggestion) return false;
  if (registeredBrands.some((entry) => !photos.some((photo) => Boolean(photo.manualOverride))
    && [entry.displayName, ...(JSON.parse(entry.aliasesJson) as string[])].some((name) =>
      normalizeBrandName(name) !== expected && descriptionContainsBrand(product.rawText, name)))) return false;

  const outputText = prependBrandBeforeShoeCode(product.outputText, brand, product.shoeCode);
  if (outputText === product.outputText) return false;
  db.prepare('UPDATE products SET output_text=?,updated_at=? WHERE id=?').run(outputText, now, productId);
  return true;
}
