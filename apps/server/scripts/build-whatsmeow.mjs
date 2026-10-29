import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
const moduleDirectory = join(serverDirectory, 'whatsmeow');
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const executable = `whatsmeow-bridge-${platform}-${architecture}${process.platform === 'win32' ? '.exe' : ''}`;
const outputPath = join(moduleDirectory, 'bin', executable);
mkdirSync(dirname(outputPath), { recursive: true });

try {
  execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', outputPath, './cmd/bridge'], {
    cwd: moduleDirectory,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '1' },
  });
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('Se requiere Go en PATH para construir whatsmeow. Instala Go y un compilador C (clang/Xcode Command Line Tools en macOS) y vuelve a ejecutar este comando.');
  }
  throw error;
}

console.log(`whatsmeow listo: ${outputPath}`);
