/**
 * Packs dist/ into a zip ready for upload to the Yandex.Games console.
 * Yandex expects a flat archive whose root contains index.html.
 */
import { readdir, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = resolve(root, 'build');
const out = resolve(outDir, 'game.zip');

async function main() {
  try {
    await stat(dist);
  } catch {
    console.error('dist/ not found. Run "npm run build" first.');
    process.exit(1);
  }

  const files = await readdir(dist);
  if (!files.includes('index.html')) {
    console.error('dist/index.html missing; the archive would be rejected.');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  // -r recurse, -q quiet, -X drop extra file attributes Yandex does not need.
  await run('zip', ['-rqX', out, '.'], { cwd: dist });

  const { size } = await stat(out);
  console.log(`build/game.zip — ${(size / 1024).toFixed(1)} KB`);
  if (size > 100 * 1024 * 1024) {
    console.warn('Warning: archive exceeds the 100 MB Yandex limit.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
