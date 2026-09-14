// Fetch immutable public reference sources; this does not build or modify PostMen.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceConfig } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = resolve(root, referenceConfig.directory);
const { repository, tag, commit, sourcePaths: paths } = referenceConfig;

const digest = (data) => createHash('sha256').update(data).digest('hex');
const manifestPath = resolve(destination, 'sources.json');

if (process.argv.includes('--verify')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.commit !== commit || manifest.tag !== tag || manifest.repository !== repository) {
    throw new Error('Unexpected reference version');
  }
  if (JSON.stringify(manifest.files.map((file) => file.path)) !== JSON.stringify(paths)) {
    throw new Error('Unexpected or missing reference files');
  }
  for (const file of manifest.files) {
    const bytes = await readFile(resolve(destination, 'source', file.path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes || blob !== file.gitBlob) {
      throw new Error(`Checksum mismatch: ${file.path}`);
    }
  }
  console.log(`Verified ${manifest.files.length} reference files at ${commit}`);
  process.exit(0);
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const tagData = JSON.parse(await fetchBytes(`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`));
if (tagData.object.type !== 'commit' || tagData.object.sha !== commit) {
  throw new Error('Tag no longer resolves to the pinned commit; investigate before replacing reference');
}
const release = JSON.parse(await fetchBytes(`https://api.github.com/repos/${repository}/releases/tags/${tag}`));
const tree = JSON.parse(await fetchBytes(`https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`));
if (tree.truncated) throw new Error('Incomplete source tree');
const blobs = new Map(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
const records = [];

// Limit requests to a small batch; verify each downloaded file against its Git blob.
for (let offset = 0; offset < paths.length; offset += 4) {
  const batch = await Promise.all(paths.slice(offset, offset + 4).map(async (path) => {
    if (!blobs.has(path)) throw new Error(`Missing source at pinned commit: ${path}`);
    const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
    const bytes = await fetchBytes(url);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== blobs.get(path)) throw new Error(`Git blob mismatch: ${path}`);
    const output = resolve(destination, 'source', path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
    return { path, url, gitBlob: blob, sha256: digest(bytes), bytes: bytes.length };
  }));
  records.push(...batch);
}

await writeFile(manifestPath, JSON.stringify({
  repository, tag, commit,
  releasePublishedAt: release.published_at,
  releaseUrl: release.html_url,
  fetchedAt: new Date().toISOString(),
  files: records,
}, null, 2) + '\n');
console.log(`Saved ${records.length} immutable reference sources to ${destination}`);
