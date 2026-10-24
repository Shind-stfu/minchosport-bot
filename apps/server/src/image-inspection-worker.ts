import { parentPort, workerData } from 'node:worker_threads';
import { LocalImageInspector } from './image-inspection.js';

const inspector = new LocalImageInspector(workerData.cachePath as string);
parentPort!.on('message', async (source: Uint8Array) => {
  try { parentPort!.postMessage({ result: await inspector.inspect(Buffer.from(source)) }); }
  catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Falló el análisis local.' }); }
});
