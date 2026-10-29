import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDataDirectory, resolveDataDirectoryOptions } from './data-directory.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryRoot() {
  const path = mkdtempSync(join(tmpdir(), 'tenis-data-directory-'));
  directories.push(path);
  return path;
}

describe('mode-isolated data directories', () => {
  it('uses one child directory per mode and keeps absolute DATA_DIR semantics as the root', () => {
    const root = temporaryRoot();
    expect(resolveDataDirectoryOptions({ appMode: 'simulation', dataDir: root })).toMatchObject({
      dataRoot: root,
      dataDirectory: join(root, 'simulation'),
      legacyDataDirectory: root,
    });
    expect(resolveDataDirectoryOptions({ appMode: 'experimental', dataDir: root }).dataDirectory).toBe(join(root, 'experimental'));
    expect(() => resolveDataDirectoryOptions({ appMode: 'simulation', dataDir: 'relative/path' })).toThrow('DATA_DIR debe ser una ruta absoluta');
  });

  it('uses the platform app-data root and appends the selected mode', () => {
    const home = temporaryRoot();
    expect(resolveDataDirectoryOptions({ appMode: 'experimental', platform: 'win32', homeDirectory: home }).dataDirectory)
      .toBe(join(home, 'AppData', 'Local', 'BotDistribuidorTenis', 'modes', 'experimental'));
    expect(resolveDataDirectoryOptions({ appMode: 'simulation', platform: 'darwin', homeDirectory: home }).dataDirectory)
      .toBe(join(home, 'Library', 'Application Support', 'BotDistribuidorTenis', 'modes', 'simulation'));
  });

  it('copies legacy data into the selected mode, including media and encrypted stores, leaving the original intact', () => {
    const root = temporaryRoot();
    const legacy = join(root, 'legacy');
    mkdirSync(join(legacy, 'media'), { recursive: true });
    mkdirSync(join(legacy, 'whatsmeow'), { recursive: true });
    writeFileSync(join(legacy, 'business.sqlite'), 'business database');
    writeFileSync(join(legacy, 'business.sqlite-wal'), 'wal snapshot');
    writeFileSync(join(legacy, 'media', 'photo.png'), 'original image');
    writeFileSync(join(legacy, 'whatsmeow', 'main.sqlite'), 'encrypted session database');

    const { dataDirectory, migratedLegacyData } = prepareDataDirectory({ appMode: 'experimental', dataDir: legacy });

    expect(migratedLegacyData).toBe(true);
    expect(dataDirectory).toBe(join(legacy, 'experimental'));
    expect(readFileSync(join(dataDirectory, 'business.sqlite'), 'utf8')).toBe('business database');
    expect(readFileSync(join(dataDirectory, 'business.sqlite-wal'), 'utf8')).toBe('wal snapshot');
    expect(readFileSync(join(dataDirectory, 'media', 'photo.png'), 'utf8')).toBe('original image');
    expect(readFileSync(join(dataDirectory, 'whatsmeow', 'main.sqlite'), 'utf8')).toBe('encrypted session database');
    expect(readFileSync(join(legacy, 'business.sqlite'), 'utf8')).toBe('business database');
    expect(existsSync(join(legacy, 'media', 'photo.png'))).toBe(true);
    expect(readdirSync(legacy).sort()).toEqual(['.legacy-layout-migrated', 'business.sqlite', 'business.sqlite-wal', 'experimental', 'media', 'whatsmeow']);
    expect(readdirSync(legacy).some((entry) => entry.includes('migration'))).toBe(false);
  });

  it('imports a legacy shared database only once, so another mode starts with a separate empty store', () => {
    const root = temporaryRoot();
    writeFileSync(join(root, 'business.sqlite'), 'experimental legacy account');
    const imported = prepareDataDirectory({ appMode: 'experimental', dataDir: root });
    const simulation = prepareDataDirectory({ appMode: 'simulation', dataDir: root });

    expect(imported.migratedLegacyData).toBe(true);
    expect(simulation.migratedLegacyData).toBe(false);
    expect(existsSync(join(simulation.dataDirectory, 'business.sqlite'))).toBe(false);
    expect(readFileSync(join(root, 'business.sqlite'), 'utf8')).toBe('experimental legacy account');
    expect(readFileSync(join(imported.dataDirectory, 'business.sqlite'), 'utf8')).toBe('experimental legacy account');
  });

  it('does not overwrite a target database or copy into a partially initialized target', () => {
    const root = temporaryRoot();
    const legacy = join(root, 'legacy');
    const target = join(legacy, 'experimental');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'business.sqlite'), 'legacy database');
    writeFileSync(join(target, 'business.sqlite'), 'current database');
    expect(prepareDataDirectory({ appMode: 'experimental', dataDir: legacy })).toMatchObject({ migratedLegacyData: false });
    expect(readFileSync(join(target, 'business.sqlite'), 'utf8')).toBe('current database');

    rmSync(join(target, 'business.sqlite'));
    writeFileSync(join(target, 'keep.txt'), 'keep me');
    expect(() => prepareDataDirectory({ appMode: 'experimental', dataDir: legacy })).toThrow('No se modificó para proteger los datos existentes');
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(legacy, 'business.sqlite'), 'utf8')).toBe('legacy database');
  });
});
