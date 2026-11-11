import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { BRAND_MODEL_ID, type ImageBrandInspection } from './image-brand-inspection.js';
import { classifySneaker } from './sneaker-model.js';
import { confidentReferenceBrand, rankBrandReferences } from './brand-reference-ranking.js';
import { normalizeBrandName, resolveVisionBrandConsensus } from './brand-candidates.js';
import { normalizeSoleMatchEmbedding, rankSoleMatchReferences } from './solematch-clip.js';

const SIGLIP_MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX';
const FLORENCE_MODEL_ID = 'onnx-community/Florence-2-base-ft';
const FLORENCE_REVISION = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const QWEN_MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const QWEN_REVISION = '8fe9dbe3fb39fe902e18df9be84b6a0ac77ae0f6';
const SOLEMATCH_CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';
const SOLEMATCH_CLIP_REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523';
const VISION_MODEL_LABEL = 'Florence-2-base-ft + Qwen3.5-0.8B';

type Message = { id: number; source: Uint8Array; action?: 'inspect' | 'screen'; candidates: string[]; evidence: ImageBrandInspection['evidence']; references?: Array<{ brand: string; source: Uint8Array }> };
type ResultRow = { label: string; score: number };
type ModelImage = import('@huggingface/transformers').RawImage;
type EmbeddingTensor = { data: ArrayLike<number>; dims: number[] };
type ImageFeatureExtractor = (images: ModelImage | ModelImage[]) => Promise<EmbeddingTensor>;
type InferenceDevice = 'auto' | 'gpu' | 'cpu' | 'dml' | 'webgpu';
type Classifier = ((image: ModelImage, labels: string[], options?: { hypothesis_template?: string }) => Promise<ResultRow[]>) & {
  tokenizer: ((texts: string[], options?: Record<string, unknown>) => Record<string, unknown>) & { _tokenizerConfig: { model_max_length?: number }; model_max_length: number };
  processor: (images: ModelImage[]) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<{ image_embeds?: EmbeddingTensor }>;
};
type VisionProcessor = ((...args: any[]) => Promise<Record<string, any>>) & {
  batch_decode: (sequences: any, options?: Record<string, unknown>) => string[];
  post_process_generation: (text: string, task: string, imageSize: [number, number]) => Record<string, any>;
  apply_chat_template: (messages: unknown[], options?: Record<string, unknown>) => string;
};
type VisionModel = { generate: (inputs: Record<string, any>) => Promise<any> };
type LoadedVisionModels = {
  florenceProcessor: VisionProcessor;
  florenceModel: VisionModel;
  qwenProcessor: VisionProcessor;
  qwenModel: VisionModel;
  RawImage: typeof import('@huggingface/transformers')['RawImage'];
};
type LoadedFlorenceModels = Pick<LoadedVisionModels, 'florenceProcessor' | 'florenceModel' | 'RawImage'>;

let classifierPromise: Promise<{ classify: Classifier; RawImage: typeof import('@huggingface/transformers')['RawImage'] }> | undefined;
let soleMatchExtractorPromise: Promise<ImageFeatureExtractor> | undefined;
let florenceModelsPromise: Promise<LoadedFlorenceModels> | undefined;
let visionModelsPromise: Promise<LoadedVisionModels> | undefined;
const soleMatchEmbeddingCache = new Map<string, number[]>();
const modelInferenceDevices = new Map<string, string>();
const configuredInferenceDevice = (workerData.inferenceDevice as InferenceDevice | undefined) ?? 'auto';
const preferredInferenceDevice: Exclude<InferenceDevice, 'auto'> = configuredInferenceDevice === 'auto'
  ? process.platform === 'win32' ? 'gpu' : 'cpu'
  : configuredInferenceDevice;
let forceCpuInference = false;
let preferDirectMlInference = false;

function inferenceDeviceOrder(): Array<Exclude<InferenceDevice, 'auto'>> {
  if (forceCpuInference) return ['cpu'];
  if (preferDirectMlInference) return ['dml', 'cpu'];
  if (preferredInferenceDevice === 'gpu' && process.platform === 'win32') return ['webgpu', 'dml', 'cpu'];
  return preferredInferenceDevice === 'cpu' ? ['cpu'] : [preferredInferenceDevice, 'cpu'];
}

async function loadWithDeviceFallback<T>(modelName: string, load: (device: Exclude<InferenceDevice, 'auto'>) => Promise<T>) {
  const devices = inferenceDeviceOrder();
  let lastError: unknown;
  for (const [index, device] of devices.entries()) {
    try {
      const model = await load(device);
      const accelerator = device === 'webgpu' ? 'GPU preferida (WebGPU)'
        : device === 'dml' ? 'GPU (DirectML)'
          : device === 'gpu' ? 'GPU preferida' : device.toUpperCase();
      modelInferenceDevices.set(modelName, index > 0 && device === 'cpu' ? `CPU (respaldo)` : accelerator);
      return model;
    } catch (error) {
      lastError = error;
      if (device !== 'cpu') {
        const message = error instanceof Error ? error.message.slice(0, 220) : `error del proveedor ${device}`;
        console.warn(`[image-brand] ${modelName} no pudo iniciar en ${device}${devices[index + 1] ? `; intenta ${devices[index + 1]}` : ''}: ${message}`);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No se pudo iniciar ${modelName} en los dispositivos disponibles.`);
}

function resetInferenceModelsForRetry(device: 'dml' | 'cpu') {
  forceCpuInference = device === 'cpu';
  preferDirectMlInference = device === 'dml';
  classifierPromise = undefined;
  soleMatchExtractorPromise = undefined;
  florenceModelsPromise = undefined;
  visionModelsPromise = undefined;
  soleMatchEmbeddingCache.clear();
  modelInferenceDevices.clear();
}

function inferenceDeviceSummary(sneakerDevice?: string) {
  const devices = [...modelInferenceDevices.entries()].map(([model, device]) => `${model}: ${device}`);
  if (sneakerDevice) devices.push(`Clasificador de zapatillas: ${sneakerDevice}`);
  return devices.join(' · ');
}

function isAcceleratorActive() {
  return [...modelInferenceDevices.values()].some((device) => !device.startsWith('CPU'));
}

async function getTransformerRuntime() {
  const packageEntry = import.meta.resolve('@huggingface/transformers');
  // The app runs in Node and persists model files locally; the browser bundle
  // intentionally reports that filesystem caching is unavailable.
  return await import(packageEntry) as any;
}

async function getClassifier() {
  classifierPromise ??= (async () => {
    const { env, pipeline, RawImage } = await getTransformerRuntime();
    const cacheDirectory = workerData.cacheDirectory as string;
    mkdirSync(cacheDirectory, { recursive: true });
    env.cacheDir = cacheDirectory;
    env.allowRemoteModels = true;
    env.useFSCache = true;
    if (env.backends?.onnx?.wasm) { env.backends.onnx.wasm.numThreads = 2; env.backends.onnx.wasm.proxy = false; }
    const classify = await loadWithDeviceFallback('SigLIP', async (device) => await pipeline('zero-shot-image-classification', SIGLIP_MODEL_ID, {
      revision: 'ba1f3b0', dtype: 'q8', device,
    }));
    // This checkpoint has a 64-token context, but its exported tokenizer may
    // omit model_max_length and otherwise attempt to pad to an enormous value.
    classify.tokenizer._tokenizerConfig.model_max_length = 64;
    return { classify, RawImage };
  })();
  return classifierPromise;
}

async function getSoleMatchExtractor(): Promise<ImageFeatureExtractor> {
  soleMatchExtractorPromise ??= (async () => {
    const runtime = await getTransformerRuntime();
    const cacheDirectory = join(dirname(workerData.cacheDirectory as string), 'solematch-clip');
    mkdirSync(cacheDirectory, { recursive: true });
    runtime.env.cacheDir = cacheDirectory;
    runtime.env.allowRemoteModels = true;
    runtime.env.useFSCache = true;
    if (runtime.env.backends?.onnx?.wasm) { runtime.env.backends.onnx.wasm.numThreads = 2; runtime.env.backends.onnx.wasm.proxy = false; }
    return await loadWithDeviceFallback('SoleMatch CLIP', async (device) => await runtime.pipeline('image-feature-extraction', SOLEMATCH_CLIP_MODEL_ID, {
      revision: SOLEMATCH_CLIP_REVISION, dtype: 'q8', device,
    }) as ImageFeatureExtractor);
  })();
  return soleMatchExtractorPromise;
}

function imageCacheKey(source: Uint8Array) {
  return createHash('sha256').update(source).digest('hex');
}

async function getSoleMatchEmbeddings(images: Array<{ source: Uint8Array; image: ModelImage }>) {
  const unique = new Map<string, ModelImage>();
  for (const item of images) {
    const key = imageCacheKey(item.source);
    if (!soleMatchEmbeddingCache.has(key)) unique.set(key, item.image);
  }
  if (unique.size) {
    const extractor = await getSoleMatchExtractor();
    const entries = [...unique.entries()];
    const output = await extractor(entries.map(([, image]) => image));
    const rowCount = output.dims[0] ?? 0;
    const width = output.dims[output.dims.length - 1] ?? 0;
    if (rowCount !== entries.length || width < 1 || output.data.length < rowCount * width) {
      throw new Error('La salida de embeddings de SoleMatch CLIP tiene una forma inesperada.');
    }
    for (let row = 0; row < rowCount; row += 1) {
      const vector = Array.from(output.data).slice(row * width, (row + 1) * width);
      soleMatchEmbeddingCache.set(entries[row]![0], normalizeSoleMatchEmbedding(vector));
    }
    while (soleMatchEmbeddingCache.size > 512) soleMatchEmbeddingCache.delete(soleMatchEmbeddingCache.keys().next().value!);
  }
  return images.map((item) => soleMatchEmbeddingCache.get(imageCacheKey(item.source))!);
}

async function getFlorenceModels(): Promise<LoadedFlorenceModels> {
  florenceModelsPromise ??= (async () => {
    const runtime = await getTransformerRuntime();
    const cacheRoot = dirname(workerData.cacheDirectory as string);
    const florenceCache = join(cacheRoot, 'florence2');
    mkdirSync(florenceCache, { recursive: true });
    runtime.env.allowRemoteModels = true;
    runtime.env.useFSCache = true;
    if (runtime.env.backends?.onnx?.wasm) { runtime.env.backends.onnx.wasm.numThreads = 2; runtime.env.backends.onnx.wasm.proxy = false; }

    runtime.env.cacheDir = florenceCache;
    const florenceProcessor = await runtime.AutoProcessor.from_pretrained(FLORENCE_MODEL_ID, { revision: FLORENCE_REVISION }) as VisionProcessor;
    const florenceModel = await loadWithDeviceFallback('Florence-2', async (device) => await runtime.Florence2ForConditionalGeneration.from_pretrained(FLORENCE_MODEL_ID, {
      revision: FLORENCE_REVISION, dtype: 'q8', device,
    }) as VisionModel);
    return { florenceProcessor, florenceModel, RawImage: runtime.RawImage };
  })();
  return florenceModelsPromise;
}

async function getVisionModels(): Promise<LoadedVisionModels> {
  visionModelsPromise ??= (async () => {
    const florence = await getFlorenceModels();
    const runtime = await getTransformerRuntime();
    const cacheRoot = dirname(workerData.cacheDirectory as string);
    const qwenCache = join(cacheRoot, 'qwen3.5');
    mkdirSync(qwenCache, { recursive: true });
    runtime.env.allowRemoteModels = true;
    runtime.env.useFSCache = true;
    if (runtime.env.backends?.onnx?.wasm) { runtime.env.backends.onnx.wasm.numThreads = 2; runtime.env.backends.onnx.wasm.proxy = false; }
    runtime.env.cacheDir = qwenCache;
    const qwenProcessor = await runtime.AutoProcessor.from_pretrained(QWEN_MODEL_ID, { revision: QWEN_REVISION }) as VisionProcessor;
    const qwenModel = await loadWithDeviceFallback('Qwen3.5', async (device) => await runtime.Qwen3_5ForConditionalGeneration.from_pretrained(QWEN_MODEL_ID, {
      revision: QWEN_REVISION,
      dtype: { embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4' },
      device,
    }) as VisionModel);
    return { ...florence, qwenProcessor, qwenModel };
  })();
  return visionModelsPromise;
}

async function decode(source: Uint8Array, RawImage: LoadedVisionModels['RawImage'] | (typeof import('@huggingface/transformers')['RawImage'])) {
  const sharp = (await import('sharp')).default;
  const decoded = await sharp(Buffer.from(source)).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  return new RawImage(pixels, decoded.info.width, decoded.info.height, 3);
}

function readBrandAnswer(answer: string, candidates: string[]) {
  const clean = answer.replace(/<\|[^|]+\|>/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!clean || /\b(?:marca por revisar|no se distingue|no puedo|no es posible|unknown|unclear|not sure|no readable brand|no logo|nondetectable|non detectable|cannot detect|cannot identify|not visible|unreadable|illegible|no se ve)\b/iu.test(clean)) return null;
  const normalizedAnswer = normalizeBrandName(clean);
  const knownMatch = [...candidates].sort((a, b) => normalizeBrandName(b).length - normalizeBrandName(a).length)
    .find((candidate) => {
      const normalized = normalizeBrandName(candidate);
      return normalized && ` ${normalizedAnswer} `.includes(` ${normalized} `);
    });
  if (knownMatch) return knownMatch;

  const firstLine = clean.split(/[\r\n.!?;]+/u)[0]!.trim()
    .replace(/^(?:(?:la marca(?: visible)?(?: en (?:la )?zapatilla)?|marca visible|the visible brand|the brand|brand)\s*(?:es|is|:)?\s*)/iu, '')
    .replace(/^(?:parece ser|parece|it looks like|looks like)\s+/iu, '')
    .replace(/["'`*_]/gu, '').trim();
  const words = firstLine.split(/\s+/u).filter(Boolean);
  if (!firstLine || firstLine.length > 40 || words.length > 4 || /\b(?:zapato|zapatilla|sneaker|shoe|logo|marca|visible|brand|probably|quizas|quizá|parece|appears)\b/iu.test(firstLine)) return null;
  return firstLine;
}

function readVisionDecision(answer: string, candidates: string[]) {
  const match = answer.match(/\{[\s\S]*\}/u);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { brand?: unknown; logo_text?: unknown; evidence?: unknown; uncertain?: unknown };
      const uncertain = parsed.uncertain === true;
      const brandText = typeof parsed.brand === 'string' ? parsed.brand.trim() : '';
      return {
        brand: uncertain || !brandText ? null : readBrandAnswer(brandText, candidates),
        logoText: typeof parsed.logo_text === 'string' ? parsed.logo_text.trim().slice(0, 100) : '',
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence.trim().slice(0, 180) : '',
      };
    } catch { /* Fall through to the plain-text parser for older model outputs. */ }
  }
  return { brand: readBrandAnswer(answer, candidates), logoText: '', evidence: '', };
}

async function locateShoes(source: Uint8Array, image: ModelImage, models: LoadedFlorenceModels) {
  const task = '<OD>';
  const inputs = await models.florenceProcessor(image, task);
  const generated = await models.florenceModel.generate({ ...inputs, max_new_tokens: 256 });
  const decoded = models.florenceProcessor.batch_decode(generated, { skip_special_tokens: false })[0] ?? '';
  const parsed = models.florenceProcessor.post_process_generation(decoded, task, [image.height, image.width]);
  const detections = parsed[task] as { labels?: unknown[]; bboxes?: unknown[][] } | undefined;
  const labels = detections?.labels;
  const boxes = detections?.bboxes;
  if (!Array.isArray(labels) || !Array.isArray(boxes)) return [] as Array<{ image: ModelImage; detailImage: ModelImage; label: string; logoText: string }>;

  const footwear = labels.flatMap((rawLabel, index) => {
    const label = String(rawLabel ?? '');
    const box = boxes[index];
    if (!/shoe|sneaker|footwear|boot|trainer|zapatilla|tenis/iu.test(label) || !Array.isArray(box) || box.length < 4) return [];
    const values = box.slice(0, 4).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return [];
    const [x1, y1, x2, y2] = values;
    if (x2! <= x1! || y2! <= y1!) return [];
    return [{ label, box: values as [number, number, number, number], area: (x2! - x1!) * (y2! - y1!) }];
  }).sort((a, b) => Number(/sneaker|shoe|boot|trainer/iu.test(b.label)) - Number(/sneaker|shoe|boot|trainer/iu.test(a.label)) || b.area - a.area);
  const unique = footwear.filter((item, index) => footwear.slice(0, index).every((prior) => {
    const overlapX = Math.max(0, Math.min(item.box[2], prior.box[2]) - Math.max(item.box[0], prior.box[0]));
    const overlapY = Math.max(0, Math.min(item.box[3], prior.box[3]) - Math.max(item.box[1], prior.box[1]));
    return overlapX * overlapY / Math.min(item.area, prior.area) < 0.72;
  })).slice(0, 2);

  const sharp = (await import('sharp')).default;
  const original = await sharp(Buffer.from(source)).metadata();
  if (!original.width || !original.height) return [] as Array<{ image: ModelImage; detailImage: ModelImage; label: string; logoText: string }>;
  const crops = await Promise.all(unique.map(async ({ box, label }) => {
    const [x1, y1, x2, y2] = box;
    const scaleX = original.width! / image.width;
    const scaleY = original.height! / image.height;
    const padX = (x2 - x1) * 0.12;
    const padY = (y2 - y1) * 0.12;
    const left = Math.max(0, Math.floor((x1 - padX) * scaleX));
    const top = Math.max(0, Math.floor((y1 - padY) * scaleY));
    const right = Math.min(original.width!, Math.ceil((x2 + padX) * scaleX));
    const bottom = Math.min(original.height!, Math.ceil((y2 + padY) * scaleY));
    const crop = await sharp(Buffer.from(source)).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).jpeg().toBuffer();
    const cropMetadata = await sharp(crop).metadata();
    const cropWidth = cropMetadata.width ?? 1;
    const cropHeight = cropMetadata.height ?? 1;
    // The full-shoe crop keeps context. The center detail crop enlarges side and tongue logos.
    const detail = await sharp(crop).extract({
      left: Math.floor(cropWidth * 0.1), top: Math.floor(cropHeight * 0.08),
      width: Math.max(1, Math.floor(cropWidth * 0.8)), height: Math.max(1, Math.floor(cropHeight * 0.84)),
    }).jpeg().toBuffer();
    const shoeImage = await decode(crop, models.RawImage);
    const detailImage = await decode(detail, models.RawImage);
    let logoText = '';
    try {
      const ocrTask = '<OCR>';
      const ocrInputs = await models.florenceProcessor(shoeImage, ocrTask);
      const ocrGenerated = await models.florenceModel.generate({ ...ocrInputs, max_new_tokens: 96 });
      const ocrDecoded = models.florenceProcessor.batch_decode(ocrGenerated, { skip_special_tokens: true })[0] ?? '';
      const ocrParsed = models.florenceProcessor.post_process_generation(ocrDecoded, ocrTask, [shoeImage.height, shoeImage.width]);
      const text = ocrParsed[ocrTask];
      logoText = (typeof text === 'string' ? text : ocrDecoded).replace(/\s+/gu, ' ').trim().slice(0, 240);
    } catch { /* The image model can still inspect the shoe when Florence OCR fails. */ }
    return { image: shoeImage, detailImage, logoText, label };
  }));
  return crops;
}

async function screenForFootwear(source: Uint8Array) {
  const models = await getFlorenceModels();
  const image = await decode(source, models.RawImage);
  const task = '<OD>';
  const inputs = await models.florenceProcessor(image, task);
  const generated = await models.florenceModel.generate({ ...inputs, max_new_tokens: 256 });
  const decoded = models.florenceProcessor.batch_decode(generated, { skip_special_tokens: false })[0] ?? '';
  const parsed = models.florenceProcessor.post_process_generation(decoded, task, [image.height, image.width]);
  const detections = parsed[task] as { labels?: unknown[]; bboxes?: unknown[][] } | undefined;
  return Boolean(detections?.labels?.some((label, index) => {
    const box = detections.bboxes?.[index];
    return /shoe|sneaker|footwear|boot|trainer|zapatilla|tenis/iu.test(String(label ?? ''))
      && Array.isArray(box) && box.length >= 4 && box.slice(0, 4).every((value) => Number.isFinite(Number(value)));
  }));
}

async function inspectLocallyWithVision(source: Uint8Array, image: ModelImage, candidates: string[]) {
  try {
    const models = await getVisionModels();
    const shoes = await locateShoes(source, image, models);
    if (!shoes.length) return { brand: null, confidence: 0, logoText: '', evidence: '', answer: 'No se encontró una zapatilla para recortar.', disagreement: false, votes: 0, totalVotes: 0, error: undefined };
    const promptFor = (logoText: string) => `Reconoce la marca de esta zapatilla usando solamente un logotipo o texto visible. No deduzcas la marca por la silueta, el modelo, la caja ni el fondo. El OCR opcional de esta zona dice: ${logoText || '(sin texto legible)'}. Si el texto puede pertenecer al proveedor o al fondo, ignóralo. Devuelve solo JSON válido con las claves brand (nombre de marca o null), logo_text (letras que realmente ves, o string vacío), evidence (breve señal visual concreta) y uncertain (boolean). Si no puedes identificar el logo con seguridad, usa brand null y uncertain true. No inventes una marca.`;
    const inspectCrop = async (crop: ModelImage, logoText: string) => {
      const chat = models.qwenProcessor.apply_chat_template([{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: promptFor(logoText) }] }], { add_generation_prompt: true });
      const inputs = await models.qwenProcessor(chat, crop);
      const generated = await models.qwenModel.generate({ ...inputs, max_new_tokens: 100, do_sample: false });
      const promptLength = (inputs.input_ids?.dims?.at(-1) as number | undefined) ?? 0;
      const answerTokens = promptLength ? generated.slice(null, [promptLength, null]) : generated;
      const answer = models.qwenProcessor.batch_decode(answerTokens, { skip_special_tokens: true })[0]?.trim() ?? '';
      return { answer, ...readVisionDecision(answer, candidates) };
    };
    const shoeResults = await Promise.all(shoes.map(async (shoe) => {
      const decisions = await Promise.all([inspectCrop(shoe.image, shoe.logoText), inspectCrop(shoe.detailImage, shoe.logoText)]);
      const names = [...new Set(decisions.map((item) => item.brand).filter((brand): brand is string => Boolean(brand)))];
      const disagrees = names.length > 1;
      const brand = disagrees ? null : names[0] ?? null;
      const matchingViews = brand ? decisions.filter((item) => item.brand && normalizeBrandName(item.brand) === normalizeBrandName(brand)).length : 0;
      const logoText = decisions.map((item) => item.logoText).find(Boolean) ?? shoe.logoText;
      const ocrSupportsBrand = Boolean(brand && logoText && ` ${normalizeBrandName(logoText)} `.includes(` ${normalizeBrandName(brand)} `));
      const confidence = brand ? matchingViews === 2 ? 0.92 : ocrSupportsBrand ? 0.82 : 0.62 : 0;
      return {
        brand, confidence, disagrees, logoText: logoText.slice(0, 120),
        evidence: decisions.map((item) => item.evidence).find(Boolean) ?? shoe.label,
        answers: decisions.map((item) => item.answer || 'Sin respuesta legible'),
      };
    }));
    const names = [...new Set(shoeResults.map((item) => item.brand).filter((brand): brand is string => Boolean(brand)))];
    const answer = shoeResults.flatMap((item) => item.answers).join(' · ');
    const logoText = shoeResults.map((item) => item.logoText).filter(Boolean).join(' · ').slice(0, 240);
    const disagreesBetweenShoes = names.length > 1 || shoeResults.some((item) => item.disagrees);
    const consensus = resolveVisionBrandConsensus(answer, logoText);
    const brand = consensus.brand ?? (disagreesBetweenShoes ? null : names[0] ?? null);
    const disagreement = disagreesBetweenShoes || consensus.disagreement;
    const confidence = brand ? consensus.brand ? consensus.confidence
      : Math.min(...shoeResults.filter((item) => item.brand).map((item) => item.confidence)) : 0;
    return {
      brand, confidence, disagreement, votes: consensus.votes, totalVotes: consensus.totalVotes,
      logoText,
      evidence: shoeResults.map((item) => item.evidence).filter(Boolean).join(' · ').slice(0, 240),
      answer,
      error: undefined,
    };
  } catch (error) {
    if (!forceCpuInference && isAcceleratorActive()) throw error;
    const message = error instanceof Error ? error.message.slice(0, 180) : 'Error de carga o inferencia del modelo visual.';
    return { brand: null, confidence: 0, logoText: '', evidence: '', answer: '', disagreement: false, votes: 0, totalVotes: 0, error: message };
  }
}

async function inspectMessage(message: Message) {
  const { classify, RawImage } = await getClassifier();
  const unknownLabel = 'a shoe with no readable or recognizable brand';
  const noShoeLabel = 'an advertisement or message that does not show shoes';
  const mixedBrandsLabel = 'an assortment of unrelated shoes with different brand logos';
  const prompts = new Map<string, string>();
  for (const brand of message.candidates.slice(0, 48)) {
    prompts.set(`a ${brand} sneaker`, brand);
    prompts.set(`a shoe with the ${brand} logo`, brand);
  }
  const image = await decode(message.source, RawImage);
  const output = await classify(image, [...prompts.keys(), unknownLabel, noShoeLabel, mixedBrandsLabel], { hypothesis_template: '{}' });
  const unknownScore = output.find((row) => row.label === unknownLabel)?.score ?? 0;
  const noShoeScore = output.find((row) => row.label === noShoeLabel)?.score ?? 0;
  const mixedBrandsScore = output.find((row) => row.label === mixedBrandsLabel)?.score ?? 0;
  const nonBrandLabels = new Set([unknownLabel, noShoeLabel, mixedBrandsLabel]);
  const byBrand = new Map<string, number>();
  for (const row of output) {
    if (nonBrandLabels.has(row.label)) continue;
    const brand = prompts.get(row.label) ?? row.label;
    byBrand.set(brand, Math.max(byBrand.get(brand) ?? 0, row.score));
  }
  const candidates = [...byBrand].map(([brand, score]) => ({ brand, score })).sort((a, b) => b.score - a.score).slice(0, 5);
  const top = candidates[0];
  const nonSingleBrandScore = Math.max(unknownScore, noShoeScore, mixedBrandsScore);
  const textSuggestion = top && top.score > nonSingleBrandScore && top.score >= 0.12 ? top.brand : null;

  let sneakerCandidates: Array<{ brand: string; score: number }> = [];
  let sneakerError: string | undefined;
  let sneakerDevice: string | undefined;
  try {
    const sneakerResult = await classifySneaker(message.source);
    sneakerCandidates = sneakerResult.candidates;
    sneakerDevice = sneakerResult.device;
  }
  catch (error) { sneakerError = error instanceof Error ? error.message.slice(0, 300) : 'Error del modelo de zapatillas.'; }
  const visual = await inspectLocallyWithVision(message.source, image, message.candidates);
  const references = message.references ?? [];
  let referenceMatches: Array<{ brand: string; score: number }> = [];
  let soleMatchMatches: Array<{ brand: string; score: number; supportCount?: number }> = [];
  let soleMatchError: string | undefined;
  const referenceImages = references.length ? await Promise.all(references.map((reference) => decode(reference.source, RawImage))) : [];
  if (references.length && classify.processor && classify.model) {
    const textInputs = classify.tokenizer(['a photo of a shoe'], { padding: 'max_length', truncation: true });
    const imageInputs = await classify.processor([image, ...referenceImages]);
    const embedded = await classify.model({ ...textInputs, ...imageInputs });
    const tensor = embedded.image_embeds;
    if (tensor && tensor.dims.length === 2 && tensor.dims[0] === references.length + 1) {
      const width = tensor.dims[1] ?? 0;
      const vector = (row: number) => Array.from(tensor.data).slice(row * width, (row + 1) * width);
      const cosine = (left: number[], right: number[]) => {
        let dot = 0, leftNorm = 0, rightNorm = 0;
        for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
          dot += left[index]! * right[index]!; leftNorm += left[index]! ** 2; rightNorm += right[index]! ** 2;
        }
        return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
      };
      const target = vector(0);
      referenceMatches = rankBrandReferences(references.map((reference, index) => ({
        brand: reference.brand, score: cosine(target, vector(index + 1)),
      })));
    }
  }
  if (references.length) {
    try {
      const embeddings = await getSoleMatchEmbeddings([
        { source: message.source, image },
        ...references.map((reference, index) => ({ source: reference.source, image: referenceImages[index]! })),
      ]);
      soleMatchMatches = rankSoleMatchReferences(embeddings[0]!, references.map((reference, index) => ({
        brand: reference.brand, embedding: embeddings[index + 1]!,
      })));
    } catch (error) {
      if (!forceCpuInference && isAcceleratorActive()) throw error;
      soleMatchError = error instanceof Error ? error.message.slice(0, 300) : 'Error de carga o inferencia de SoleMatch CLIP.';
    }
  }
  const referenceSuggestion = confidentReferenceBrand(referenceMatches);
  // Florence locates the shoe, logo-crop OCR supplies text, and Qwen reads the logo.
  // SigLIP is only a fallback suggestion. Its scores and the closed-set sneaker
  // classifier never overrule a logo read or create a conflict by themselves.
  const suggestedBrand = visual.brand ?? textSuggestion ?? referenceSuggestion;
  const strongSiglipSuggestion = top && top.score >= 0.3 ? textSuggestion : null;
  const conflictingStrongSignal = [strongSiglipSuggestion, referenceSuggestion].some((candidate) => candidate
    && visual.brand && visual.confidence >= 0.8 && normalizeBrandName(candidate) !== normalizeBrandName(visual.brand));
  const conflict = Boolean(conflictingStrongSignal);
  const score = visual.brand ? visual.confidence : 0;
  const evidence: ImageBrandInspection['evidence'] = {
    ...message.evidence, unknownScore, noShoeScore, mixedBrandsScore, brandConflict: conflict || visual.disagreement,
    ...(sneakerCandidates.length ? { sneakerCandidates } : {}),
    ...(sneakerError ? { sneakerError } : {}),
    inferenceDevice: inferenceDeviceSummary(sneakerDevice),
    ...(referenceMatches.length ? { referenceMatches } : {}),
    ...(soleMatchMatches.length ? { soleMatchMatches } : {}),
    ...(soleMatchError ? { soleMatchError } : {}),
    visualBrand: visual.brand,
    ...(visual.answer ? { visualAnswer: visual.answer } : {}),
    ...(visual.logoText ? { visualLogoText: visual.logoText } : {}),
    ...(visual.evidence ? { visualEvidence: visual.evidence } : {}),
    visualConfidence: visual.confidence,
    visualModel: VISION_MODEL_LABEL,
    ...(visual.error ? { visualError: visual.error } : {}),
  };
  const result: ImageBrandInspection = {
    modelId: BRAND_MODEL_ID,
    status: suggestedBrand ? 'review' : 'unknown',
    suggestedBrand,
    confirmedBrand: null,
    score,
    candidates,
    evidence,
    autoEligible: false,
    reason: conflict ? `Florence + Qwen sugirió ${suggestedBrand}; SigLIP tiene otra señal fuerte y requiere revisión.`
      : visual.brand && visual.disagreement ? `Florence + Qwen leyó ${visual.brand} en ${visual.votes} de ${visual.totalVotes} respuestas; una lectura discrepa y requiere revisión.`
      : visual.brand ? `Florence localizó el calzado; Qwen leyó ${visual.brand} en ${visual.confidence >= 0.8 ? 'vistas concordantes o apoyadas por OCR' : 'una vista'}. La marca sigue sujeta a la calibración independiente.`
        : referenceSuggestion ? 'Sugerencia secundaria basada en varias fotos de referencia; requiere revisión.'
          : suggestedBrand ? 'Sugerencia secundaria de SigLIP; requiere revisión y validación con fotos propias.'
            : noShoeScore >= mixedBrandsScore && noShoeScore >= unknownScore ? 'La imagen parece un anuncio sin calzado; no se asignó marca.'
              : mixedBrandsScore >= unknownScore ? 'La imagen podría mostrar varias marcas; requiere revisión.'
                : visual.error ? 'No se pudo leer el logo con el modelo visual local y no hay evidencia suficiente para sugerir una marca.'
                  : 'No se distinguió una marca con evidencia suficiente.',
    error: null,
  };
  parentPort!.postMessage({ id: message.id, result });
}

async function processMessage(message: Message) {
  if (message.action === 'screen') parentPort!.postMessage({ id: message.id, hasFootwear: await screenForFootwear(message.source) });
  else await inspectMessage(message);
}

async function processMessageWithFallback(message: Message) {
  try {
    await processMessage(message);
  } catch (error) {
    if (!forceCpuInference && preferredInferenceDevice !== 'cpu' && isAcceleratorActive()) {
      const reason = error instanceof Error ? error.message.slice(0, 220) : 'falló la inferencia acelerada';
      const webGpuFailed = !preferDirectMlInference && [...modelInferenceDevices.values()].some((device) => device.includes('WebGPU'));
      let finalError = error;
      if (webGpuFailed) {
        console.warn(`[image-brand] Falló la inferencia en WebGPU; se reinician los modelos para probar DirectML: ${reason}`);
        resetInferenceModelsForRetry('dml');
        try {
          await processMessage(message);
          return;
        } catch (directMlError) {
          finalError = directMlError;
        }
      }
      const fallbackReason = finalError instanceof Error ? finalError.message.slice(0, 220) : reason;
      console.warn(`[image-brand] Falló la inferencia acelerada; se reinician los modelos para continuar en CPU: ${fallbackReason}`);
      resetInferenceModelsForRetry('cpu');
      try {
        await processMessage(message);
        return;
      } catch (retryError) {
        finalError = retryError;
      }
      error = finalError;
    }
    const messageText = error instanceof Error ? error.message.slice(0, 300) : 'Error desconocido al clasificar la marca.';
    parentPort!.postMessage({ id: message.id, error: messageText });
  }
}

let queue = Promise.resolve();
parentPort!.on('message', (message: Message) => {
  queue = queue.then(async () => await processMessageWithFallback(message));
});
