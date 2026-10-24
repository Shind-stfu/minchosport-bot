const { parentPort } = require('node:worker_threads');
parentPort.on('message', bytes => {
  if (bytes[0] === 2) return;
  if (bytes[0] === 3) process.exit(1);
  const until = Date.now() + 60;
  while (Date.now() < until) { /* Simulate a CPU-bound image scan off the server thread. */ }
  parentPort.postMessage({ result: { ocrText: String(bytes[0]), ocrConfidence: 1, ocrError: null, codeCandidates: [], detectedCode: null, detectedCodeConfidence: 0, world: { detected: false, variant: null, confidence: 0, bounds: null }, regions: [] } });
});
