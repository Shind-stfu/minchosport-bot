import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { BRAND_MODEL_ID, type ImageBrandInspection } from './image-brand-inspection.js';
import { normalizeBrandName, resolveVisionBrandConsensus } from './brand-candidates.js';

const FLORENCE_MODEL_ID = 'onnx-community/Florence-2-base-ft';
const FLORENCE_REVISION = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const QWEN_MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const QWEN_REVISION = '8fe9dbe3fb39fe902e18df9be84b6a0ac77ae0f6';
const VISION_MODEL_LABEL = 'Florence-2-base-ft + Qwen3.5-0.8B';

type Message = { id: number; source: Uint8Array; action?: 'inspect' | 'screen'; candidates: string[]; evidence: ImageBrandInspection['evidence'] };
type ModelImage = import('@huggingface/transformers').RawImage;
type InferenceDevice = 'auto' | 'gpu' | 'cpu' | 'dml' | 'webgpu';
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

let florenceModelsPromise: Promise<LoadedFlorenceModels> | undefined;
let visionModelsPromise: Promise<LoadedVisionModels> | undefined;
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
  florenceModelsPromise = undefined;
  visionModelsPromise = undefined;
  modelInferenceDevices.clear();
}

function inferenceDeviceSummary() {
  const devices = [...modelInferenceDevices.entries()].map(([model, device]) => `${model}: ${device}`);
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

async function inspectLocallyWithVision(source: Uint8Array, candidates: string[]) {
  try {
    const models = await getVisionModels();
    const image = await decode(source, models.RawImage);
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
  const visual = await inspectLocallyWithVision(message.source, message.candidates);
  const evidence: ImageBrandInspection['evidence'] = {
    ...message.evidence,
    inferenceDevice: inferenceDeviceSummary(),
    brandConflict: visual.disagreement,
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
    status: visual.brand ? 'review' : 'unknown',
    suggestedBrand: visual.brand,
    confirmedBrand: null,
    score: visual.brand ? visual.confidence : 0,
    candidates: [],
    evidence,
    autoEligible: false,
    reason: visual.brand && visual.disagreement ? `Qwen leyó ${visual.brand} en ${visual.votes} de ${visual.totalVotes} vistas; las lecturas discrepan y requiere revisión.`
      : visual.brand ? `Florence localizó el calzado; Qwen leyó ${visual.brand} en ${visual.confidence >= 0.8 ? 'vistas concordantes o apoyadas por OCR' : 'una vista'}. La marca sigue sujeta a la calibración independiente.`
        : visual.error ? 'No se pudo leer el logo con Florence + Qwen y no hay evidencia suficiente para sugerir una marca.'
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
