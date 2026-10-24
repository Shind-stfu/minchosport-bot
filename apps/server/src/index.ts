import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import pino from 'pino';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { BaileysSessionRegistry } from './whatsapp.js';
import { SupplierIngestionService } from './supplier-ingestion.js';
import { SupplierReceptionService } from './supplier-reception.js';
import { OutboundDistributionRegistry } from './outbound-distribution.js';
import { ImageInspectorPool } from './image-inspector-pool.js';
import { ImageInspectionCoordinator } from './image-inspection-coordinator.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const Environment = z.object({
  APP_MODE: z.enum(['simulation', 'experimental']).default('simulation'),
  WHATSAPP_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  WHATSAPP_SEND_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3210),
  DATA_DIR: z.string().optional(),
  DEFAULT_MARGIN_COP: z.coerce.number().refine((value) => value === 5000 || value === 10000).transform((value) => value as 5000 | 10000).default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  IMAGE_ANALYSIS_WORKERS: z.coerce.number().int().min(1).max(4).optional(),
});

const config = Environment.parse(process.env);
const fallbackDataDirectory = process.platform === 'win32'
  ? resolve(process.env.LOCALAPPDATA ?? joinPath(homedir(), 'AppData', 'Local'), 'BotDistribuidorTenis', 'simulation')
  : resolve(homedir(), 'Library', 'Application Support', 'BotDistribuidorTenis', 'simulation');
const dataDirectory = resolve(config.DATA_DIR ?? fallbackDataDirectory);
if (config.DATA_DIR && !isAbsolute(config.DATA_DIR)) {
  throw new Error('DATA_DIR debe ser una ruta absoluta para evitar guardar datos en una carpeta inesperada.');
}
mkdirSync(dataDirectory, { recursive: true });
const database = openDatabase(resolve(dataDirectory, 'business.sqlite'), config.DEFAULT_MARGIN_COP);
const messagingEnabled = config.APP_MODE === 'experimental' && config.WHATSAPP_ENABLED;
const whatsappLogger = pino({ level: config.LOG_LEVEL, redact: { paths: ['*.qr', '*.token', '*.password'], censor: '[REDACTED]' } });
const imageInspections = new ImageInspectionCoordinator(database, dataDirectory, new ImageInspectorPool(join(dataDirectory, 'ocr-cache'), config.IMAGE_ANALYSIS_WORKERS));
const supplierIngestion = new SupplierIngestionService(database, dataDirectory, whatsappLogger, (assetId) => { void imageInspections.schedule(assetId); });
const supplierReception = new SupplierReceptionService(database, dataDirectory, supplierIngestion, whatsappLogger);
const sessions = new BaileysSessionRegistry(database, whatsappLogger, messagingEnabled, supplierIngestion, supplierReception);
const distributions = new OutboundDistributionRegistry(database, dataDirectory, (sessionId) => sessions.get(sessionId), whatsappLogger, messagingEnabled && config.WHATSAPP_SEND_ENABLED);
for (const row of database.prepare('SELECT id FROM whatsapp_sessions WHERE archived_at IS NULL').all() as Array<{ id: string }>) distributions.get(row.id);
const app = createApp({ db: database, dataDirectory, logLevel: config.LOG_LEVEL, port: config.PORT, sessionRegistry: sessions, messagingEnabled, distributionRegistry: distributions, realSendsEnabled: messagingEnabled && config.WHATSAPP_SEND_ENABLED, imageInspections, supplierReception });
imageInspections.resume();
const logger = app.log;

let shuttingDown = false;
async function stop(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Cerrando servicio local');
  try { await supplierReception.close(); await sessions.close(); await app.close(); process.exitCode = 0; }
  catch (error) { logger.error({ err: error }, 'Error al cerrar'); process.exitCode = 1; }
}
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ host: config.HOST, port: config.PORT, mode: config.APP_MODE, dataDirectory }, 'Panel local iniciado');
  supplierReception.start();
  void sessions.connectSavedSessions();
} catch (error) {
  logger.error({ err: error }, 'No se pudo iniciar el servidor local');
  await supplierReception.close();
  await sessions.close();
  await app.close();
  process.exitCode = 1;
}

function joinPath(...parts: string[]) { return join(...parts); }
