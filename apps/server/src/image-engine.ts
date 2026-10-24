import type { ImageInspection } from './image-inspection.js';

// Bump when recognition/preprocessing changes so older cached results are not reused.
export const IMAGE_ENGINE_VERSION = 'local-ocr-consensus-v2';
export interface ImageInspector {
  readonly concurrency?: number;
  readonly version?: string;
  inspect(source: Buffer): Promise<ImageInspection>;
  close?(): Promise<void>;
}
