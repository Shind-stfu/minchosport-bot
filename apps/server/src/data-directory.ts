import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AppMode = 'simulation' | 'experimental';

export interface DataDirectoryOptions {
  appMode: AppMode;
  dataDir?: string;
  fallbackRoot?: string;
  legacyFallbackDirectory?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
}

export interface PreparedDataDirectory {
  dataDirectory: string;
  migratedLegacyData: boolean;
}

export function resolveDataDirectoryOptions(options: DataDirectoryOptions) {
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const defaultBase = platform === 'win32'
    ? join(options.localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'BotDistribuidorTenis')
    : join(home, 'Library', 'Application Support', 'BotDistribuidorTenis');
  const fallbackRoot = options.fallbackRoot ?? join(defaultBase, 'modes');
  if (options.dataDir && !isAbsolute(options.dataDir)) {
    throw new Error('DATA_DIR debe ser una ruta absoluta para evitar guardar datos en una carpeta inesperada.');
  }

  const dataRoot = resolve(options.dataDir ?? fallbackRoot);
  return {
    dataRoot,
    dataDirectory: join(dataRoot, options.appMode),
    migrationMarker: join(dataRoot, '.legacy-layout-migrated'),
    // Older releases treated DATA_DIR as the mode directory itself. Preserve
    // that data on first start with the new per-mode directory layout.
    legacyDataDirectory: resolve(options.dataDir ?? options.legacyFallbackDirectory ?? join(defaultBase, 'simulation')),
  };
}

/** Copies a legacy data folder once, leaving the original untouched. */
export function prepareDataDirectory(options: DataDirectoryOptions): PreparedDataDirectory {
  const paths = resolveDataDirectoryOptions(options);
  const { dataDirectory, dataRoot, legacyDataDirectory, migrationMarker } = paths;
  const markLegacyMigrated = () => {
    if (existsSync(migrationMarker)) return;
    try { writeFileSync(migrationMarker, 'v1\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  };
  if (existsSync(join(dataDirectory, 'business.sqlite'))) {
    markLegacyMigrated();
    mkdirSync(dataDirectory, { recursive: true });
    return { dataDirectory, migratedLegacyData: false };
  }

  if (existsSync(dataDirectory) && readdirSync(dataDirectory).length > 0) {
    throw new Error(`La carpeta de datos ${dataDirectory} ya contiene archivos, pero no una base de datos. No se modificó para proteger los datos existentes.`);
  }

  if (existsSync(migrationMarker)) {
    mkdirSync(dataDirectory, { recursive: true });
    return { dataDirectory, migratedLegacyData: false };
  }

  const sourceDatabase = join(legacyDataDirectory, 'business.sqlite');
  if (!existsSync(sourceDatabase) || !statSync(sourceDatabase).isFile()) {
    mkdirSync(dataDirectory, { recursive: true });
    return { dataDirectory, migratedLegacyData: false };
  }

  mkdirSync(dataRoot, { recursive: true });
  const stagingDirectory = join(dirname(dataDirectory), `.${basename(dataDirectory)}-migration-${randomUUID()}`);
  const excludedPaths = new Set([resolve(dataDirectory), resolve(stagingDirectory), resolve(migrationMarker)]);
  try {
    mkdirSync(stagingDirectory, { mode: 0o700 });
    for (const entry of readdirSync(legacyDataDirectory)) {
      const sourcePath = join(legacyDataDirectory, entry);
      const absolutePath = resolve(sourcePath);
      if (excludedPaths.has(absolutePath) || [...excludedPaths].some((excluded) => absolutePath.startsWith(`${excluded}${sep}`))) continue;
      cpSync(sourcePath, join(stagingDirectory, entry), { recursive: true, errorOnExist: true });
    }
    if (existsSync(dataDirectory)) rmSync(dataDirectory, { recursive: true });
    renameSync(stagingDirectory, dataDirectory);
    markLegacyMigrated();
    return { dataDirectory, migratedLegacyData: true };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw new Error(`No se pudieron copiar los datos anteriores a ${dataDirectory}. La carpeta original ${legacyDataDirectory} se conservó.`, { cause: error });
  }
}
