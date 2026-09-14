// Offline integrity checks for M0 evidence, not PostMen application tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceConfig } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reference = resolve(root, referenceConfig.directory);
const manifest = JSON.parse(await readFile(resolve(reference, 'captures.json'), 'utf8'));
const states = [
  'empty-light', 'empty-dark', 'theme-dropdown-dark', 'create-collection-inline-dark',
  'params-dark', 'method-dropdown-dark', 'response-dark', 'headers-dark',
  'json-body-response-dark', 'json-body-response-light', 'multipart-dark',
  'server-error-dark', 'loading-dark', 'request-context-menu-dark',
  'delete-request-modal-dark', 'vertical-layout-dark', 'sidebar-collapsed-dark',
];
assert.equal(manifest.version, '4.1.0');
assert.equal(manifest.platform, 'darwin');
assert.equal(manifest.architecture, 'arm64');
assert.equal(manifest.electron, '37.6.1');
assert.equal(manifest.chrome, '138.0.7204.251');
assert.equal(manifest.archiveSha256, 'dffefd85d40f14015d23691a92d227f425baf4d581d26086adc2333cff8b99e0');
assert.equal(manifest.isolatedProfile, true);
assert.equal(manifest.zoomFactor, 1);
assert.equal(manifest.displayScale, 2);
assert.deepEqual(manifest.captures.map((capture) => capture.name), states);
assert.deepEqual(
  (await readdir(resolve(reference, 'screenshots'))).filter((file) => file.endsWith('.png')).sort(),
  states.map((name) => `${name}.png`).sort(),
  'Unexpected or missing PNGs; do not mix capture runs',
);

const element = (capture, selector) => {
  const match = capture.elements.find((entry) => entry.selector === selector);
  assert.ok(match, `${capture.name}: missing ${selector}`);
  return match;
};
for (const capture of manifest.captures) {
  assert.equal(capture.file, `screenshots/${capture.name}.png`);
  const bytes = await readFile(resolve(reference, capture.file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.sha256, capture.name);
  assert.deepEqual(capture.viewport, { width: 1440, height: 840 });
  assert.equal(capture.devicePixelRatio, 2);
  assert.deepEqual(capture.png, { width: 2880, height: 1680 });
  assert.equal(bytes.readUInt32BE(16), capture.png.width);
  assert.equal(bytes.readUInt32BE(20), capture.png.height);
  assert.equal(capture.theme, capture.name.endsWith('-light') ? 'light' : 'dark');
  assert.equal(capture.rootFontSize, '16px');
  assert.equal(capture.bodyFont.size, '13px');
  assert.equal(element(capture, '.app-titlebar').y, 0, `${capture.name}: scrolled app shell`);
  assert.equal(element(capture, '.app-titlebar').height, 36);
  assert.equal(element(capture, '.status-bar').height, 24);
  assert.equal(element(capture, '.status-bar').y, 816);
}
const state = (name) => manifest.captures.find((capture) => capture.name === name);
const vertical = state('vertical-layout-dark');
const request = element(vertical, '[data-testid="request-pane"]');
const response = element(vertical, '[data-testid="response-pane"]');
assert.equal(request.x, response.x);
assert.equal(response.y - (request.y + request.height), 12);
assert.equal(request.height, 380);
assert.ok(!state('sidebar-collapsed-dark').elements.some((entry) => entry.selector === '[data-testid="sidebar"]'));
assert.match(element(state('server-error-dark'), '[data-testid="response-pane"]').text, /500/);
assert.match(element(state('loading-dark'), '[data-testid="response-pane"]').text, /Cancel Request/);
assert.equal(element(state('delete-request-modal-dark'), '[role="dialog"]').width, 500);
for (const name of ['json-body-response-dark', 'json-body-response-light']) {
  assert.equal(state(name).elements.filter((entry) => entry.selector === '.CodeMirror' && entry.font.includes('Fira Code')).length, 2);
}
console.log(`Verified ${states.length} PNG checksums, viewport/theme metadata, and key reference states`);
