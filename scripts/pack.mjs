/**
 * Packs each game into its own zip for the Yandex.Games console.
 *
 * Yandex serves an archive's root `index.html`, so the merge build (which the
 * multi-page bundle emits under /merge) is promoted to the root in its own
 * archive, with its asset references rewritten to match.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = resolve(root, 'build');

const MAX_BYTES = 100 * 1024 * 1024;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function zipDir(dir, out) {
  await rm(out, { force: true });
  // -r recurse, -q quiet, -X drop the extra attributes Yandex does not need.
  await run('zip', ['-rqX', out, '.'], { cwd: dir });
  const { size } = await stat(out);
  return size;
}

/**
 * Walks the asset graph from a page's HTML so each archive carries only the
 * files that page actually loads. Both games share a chunk, and neither
 * should ship the other's bundle.
 */
async function collectAssets(html) {
  const names = new Set();
  const queue = [];

  for (const m of html.matchAll(/assets\/([A-Za-z0-9._-]+)/g)) {
    if (!names.has(m[1])) {
      names.add(m[1]);
      queue.push(m[1]);
    }
  }

  while (queue.length) {
    const name = queue.pop();
    if (!/\.(js|css)$/.test(name)) continue;
    let text;
    try {
      text = await readFile(resolve(dist, 'assets', name), 'utf8');
    } catch {
      continue;
    }
    // Sibling chunks are referenced by bare filename from inside a bundle.
    for (const m of text.matchAll(/["'.\/]([A-Za-z0-9._-]+\.(?:js|css))["'\)]/g)) {
      const dep = m[1];
      if (names.has(dep)) continue;
      if (!(await exists(resolve(dist, 'assets', dep)))) continue;
      names.add(dep);
      queue.push(dep);
    }
  }
  return names;
}

async function stageAssets(stage, names) {
  await mkdir(resolve(stage, 'assets'), { recursive: true });
  for (const name of names) {
    await cp(resolve(dist, 'assets', name), resolve(stage, 'assets', name));
  }
}

async function buildDriftArchive(stage) {
  const html = await readFile(resolve(dist, 'index.html'), 'utf8');
  await writeFile(resolve(stage, 'index.html'), html, 'utf8');
  await stageAssets(stage, await collectAssets(html));
  return zipDir(stage, resolve(outDir, 'drift.zip'));
}

async function buildMergeArchive(stage) {
  const source = await readFile(resolve(dist, 'merge', 'index.html'), 'utf8');
  // The page moves up one level, so its relative asset paths move with it.
  const html = source.replaceAll('../assets/', 'assets/');
  await writeFile(resolve(stage, 'index.html'), html, 'utf8');
  await stageAssets(stage, await collectAssets(html));
  return zipDir(stage, resolve(outDir, 'merge.zip'));
}

async function main() {
  if (!(await exists(dist))) {
    console.error('dist/ not found. Run "npm run build" first.');
    process.exit(1);
  }
  const files = await readdir(dist);
  if (!files.includes('index.html')) {
    console.error('dist/index.html missing; the archive would be rejected.');
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const staging = resolve(outDir, '.staging');
  await rm(staging, { recursive: true, force: true });

  const driftStage = resolve(staging, 'drift');
  const mergeStage = resolve(staging, 'merge');
  await mkdir(driftStage, { recursive: true });
  await mkdir(mergeStage, { recursive: true });

  const driftSize = await buildDriftArchive(driftStage);
  const mergeSize = await buildMergeArchive(mergeStage);
  await rm(staging, { recursive: true, force: true });

  for (const [name, size] of [
    ['build/drift.zip', driftSize],
    ['build/merge.zip', mergeSize],
  ]) {
    console.log(`${name} — ${(size / 1024).toFixed(1)} KB`);
    if (size > MAX_BYTES) console.warn(`Warning: ${name} exceeds the 100 MB Yandex limit.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
