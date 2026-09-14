// Native Electron reference capture, using an isolated disposable profile.
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { referenceConfig } from './config.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const modulePath = option('--playwright-module');
if (!modulePath) throw new Error('Pass --playwright-module /absolute/path/to/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(resolve(modulePath)).href);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = resolve(root, option('--output', referenceConfig.directory));
if (option('--output') && !destination.startsWith(resolve(root, 'docs/milestones/M4') + '/')) throw new Error('Alternative reference output must be under docs/milestones/M4/');
const scratch = await mkdtemp(join(tmpdir(), 'postmen-reference-capture-'));
const profile = join(scratch, 'profile');
const collection = join(scratch, 'PostMen Reference');
await mkdir(profile, { recursive: true });
await mkdir(join(collection, 'Users'), { recursive: true });
await mkdir(join(collection, 'Assets'), { recursive: true });
await mkdir(join(destination, 'screenshots'), { recursive: true });
const server = createServer((request, response) => {
  const reply = () => {
    response.writeHead(request.url?.startsWith('/error') ? 500 : 200, {
      'Content-Type': 'application/json',
      'X-Reference': 'PostMen M0',
      'Cache-Control': 'no-store',
      Date: 'Sat, 05 Sep 2026 00:00:00 GMT',
    });
    response.end(JSON.stringify({
      success: !request.url?.startsWith('/error'),
      data: { id: 42, name: 'Alex Morgan', email: 'alex@example.com', active: true },
    }, null, 2));
  };
  if (request.url?.startsWith('/slow')) {
    const timer = setTimeout(reply, 15000);
    response.on('close', () => clearTimeout(timer));
  }
  else reply();
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(43119, '127.0.0.1', done); });
const baseUrl = 'http://127.0.0.1:43119';
await writeFile(join(collection, referenceConfig.collectionFile), JSON.stringify({ version: '1', name: 'PostMen Reference', type: 'collection' }));
const requestFile = (name, method, path, seq, body = 'none', extra = '') =>
  `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\n${method} {\n  url: ${baseUrl}${path}\n  body: ${body}\n  auth: none\n}\n\n${extra}\n`;
await writeFile(join(collection, 'Users', 'List users.bru'), requestFile('List users', 'get', '/users?limit=10&active=true', 1, 'none', 'params:query {\n  limit: 10\n  active: true\n}\n\nheaders {\n  Accept: application/json\n  X-Workspace: PostMen\n}'));
await writeFile(join(collection, 'Users', 'Create user.bru'), requestFile('Create user', 'post', '/users', 2, 'json', 'headers {\n  Content-Type: application/json\n}\n\nbody:json {\n  {\n    "name": "Alex Morgan",\n    "email": "alex@example.com",\n    "active": true\n  }\n}'));
await writeFile(join(collection, 'Assets', 'Upload asset.bru'), requestFile('Upload asset', 'post', '/upload', 1, 'multipartForm', 'body:multipart-form {\n  description: Profile picture\n}'));
await writeFile(join(collection, 'Slow response.bru'), requestFile('Slow response', 'get', '/slow', 3));
await writeFile(join(collection, 'Server error.bru'), requestFile('Server error', 'get', '/error', 4));
await writeFile(join(profile, 'preferences.json'), JSON.stringify({
  preferences: {
    onboarding: { hasLaunchedBefore: true, hasSeenWelcomeModal: true, lastSeenVersion: '4.1.0' },
    general: { defaultLocation: scratch, defaultWorkspacePath: join(scratch, 'workspaces') },
    display: { zoomPercentage: 100 },
  },
}));

let application;
try {
  application = await _electron.launch({
    executablePath: option('--executable', referenceConfig.executable),
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, DISABLE_SINGLE_INSTANCE: 'true', PLAYWRIGHT: 'true' },
    timeout: 25000,
  });
  const actualProfile = await application.evaluate(({ app }) => app.getPath('userData'));
  if (await realpath(actualProfile) !== await realpath(profile)) throw new Error(`Profile isolation failed: ${actualProfile}`);
  const actualVersion = await application.evaluate(({ app }) => app.getVersion());
  if (actualVersion !== '4.1.0') throw new Error(`Expected reference version 4.1.0, found ${actualVersion}`);
  const page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1440, 840);
    window.webContents.setZoomFactor(1);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 20000 });
  await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 840);
  await page.evaluate(() => document.fonts.ready);
  const captures = [];
  const screenshot = async (name) => {
    await page.mouse.move(720, 16);
    // Responsive tabs debounce for 150ms; overlays also animate on entry.
    await page.waitForTimeout(750);
    await page.evaluate(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      document.body.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      // Focus can scroll the app's outer container, not just the document.
      for (let parent = document.querySelector('.app-titlebar')?.parentElement; parent; parent = parent.parentElement) {
        parent.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      }
    });
    await page.waitForFunction(() => document.querySelector('.app-titlebar')?.getBoundingClientRect().y === 0);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const bytes = await page.screenshot({ path: join(destination, 'screenshots', `${name}.png`), animations: 'disabled' });
    const metrics = await page.evaluate(() => {
      const selectors = [
        '.app-titlebar', '.status-bar', '[data-testid="sidebar"]', '[data-testid="sidebar-drag-handle"]',
        '.tabs-scroll-container', '.query-url-wrapper', '[data-testid="method-selector"]', '[data-testid="send-arrow-icon"]',
        '[data-testid="request-pane"]', '[data-testid="response-pane"]', '.dragbar-wrapper',
        '[role="tab"]', '.CodeMirror', '.CodeMirror-linenumber', '.CodeMirror-line', 'table', 'table th', 'table tbody tr',
        '[role="dialog"]', 'input',
      ];
      const elements = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return [];
        return [{ selector, text: element.textContent?.trim().slice(0, 80),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          font: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight,
          color: style.color, background: style.backgroundColor, border: style.border, radius: style.borderRadius,
        }];
      }));
      return { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, theme: document.documentElement.className,
        scroll: { windowY: scrollY, bodyTop: document.body.scrollTop },
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        bodyFont: { family: getComputedStyle(document.body).fontFamily, size: getComputedStyle(document.body).fontSize },
        elements };
    });
    captures.push({ name, file: `screenshots/${name}.png`, sha256: createHash('sha256').update(bytes).digest('hex'),
      png: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, ...metrics });
    console.log(`Captured ${name}`);
  };
  for (const mode of ['light', 'dark']) {
    await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
    await page.getByTitle(mode === 'light' ? 'Light' : 'Dark', { exact: true }).click();
    await page.waitForFunction((theme) => document.documentElement.classList.contains(theme), mode);
    await page.keyboard.press('Escape');
    await screenshot(`empty-${mode}`);
  }
  await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
  await screenshot('theme-dropdown-dark');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await screenshot('create-collection-inline-dark');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await application.evaluate(({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] });
  }, collection);
  await page.getByRole('button', { name: 'Open Collection', exact: true }).click();
  await page.getByText('PostMen Reference', { exact: true }).first().waitFor({ timeout: 12000 }).catch(async (error) => {
    console.log('Collection open state:', await page.locator('body').innerText());
    throw error;
  });
  await page.getByTestId('sidebar').getByText('PostMen Reference', { exact: true }).click();
  await page.getByTestId('sidebar').getByText('Users', { exact: true }).click();
  await page.getByTestId('sidebar').getByText('List users', { exact: true }).dblclick();
  await page.getByTestId('request-pane').waitFor();
  await page.getByText('Collection added to workspace', { exact: true }).waitFor({ state: 'hidden', timeout: 12000 });
  await page.getByTestId('migrate-yml-pill-dismiss').click();
  await screenshot('params-dark');
  await page.getByTestId('method-selector').click();
  await screenshot('method-dropdown-dark');
  await page.getByTestId('method-selector').click();
  await page.getByTestId('send-arrow-icon').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="response-pane"]')?.textContent.includes('Alex Morgan'));
  await screenshot('response-dark');
  await page.getByTestId('response-pane').getByRole('tab', { name: /^Headers/ }).click();
  await page.getByTestId('request-pane').getByRole('tab', { name: /^Headers/ }).click();
  await screenshot('headers-dark');
  await page.getByTestId('sidebar').getByText('Create user', { exact: true }).dblclick();
  await page.getByTestId('request-pane').getByRole('tab', { name: 'Body', exact: true }).click();
  await page.getByTestId('send-arrow-icon').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="response-pane"]')?.textContent.includes('Alex Morgan'));
  await screenshot('json-body-response-dark');
  if (process.argv.includes('--repeat')) await screenshot('json-body-response-dark-repeat');
  await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
  await page.getByTitle('Light', { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('light'));
  await page.keyboard.press('Escape');
  await screenshot('json-body-response-light');
  if (process.argv.includes('--repeat')) await screenshot('json-body-response-light-repeat');
  await page.getByRole('button', { name: 'Change Theme', exact: true }).click();
  await page.getByTitle('Dark', { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar').getByText('Assets', { exact: true }).click();
  await page.getByTestId('sidebar').getByText('Upload asset', { exact: true }).dblclick();
  await page.getByTestId('request-pane').getByRole('tab', { name: 'Body', exact: true }).click();
  await screenshot('multipart-dark');
  await page.getByTestId('sidebar').getByText('Server error', { exact: true }).dblclick();
  await page.getByTestId('send-arrow-icon').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="response-pane"]')?.textContent.includes('500'));
  await screenshot('server-error-dark');
  await page.getByTestId('sidebar').getByText('Slow response', { exact: true }).dblclick();
  await page.getByTestId('send-arrow-icon').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await screenshot('loading-dark');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('sidebar').getByText('Create user', { exact: true }).dblclick();
  await page.getByTestId('sidebar').getByText('Create user', { exact: true }).click({ button: 'right' });
  await screenshot('request-context-menu-dark');
  await page.getByText('Delete', { exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await screenshot('delete-request-modal-dark');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.app-titlebar').getByTestId('response-layout-toggle-btn').click();
  await page.waitForFunction(() => {
    const a = document.querySelector('[data-testid="request-pane"]').getBoundingClientRect();
    const b = document.querySelector('[data-testid="response-pane"]').getBoundingClientRect();
    return b.y > a.y && b.x === a.x;
  });
  await screenshot('vertical-layout-dark');
  await page.locator('.app-titlebar').getByTestId('response-layout-toggle-btn').click();
  await page.getByTestId('toggle-sidebar-button').click();
  await page.getByTestId('sidebar').waitFor({ state: 'hidden' });
  await screenshot('sidebar-collapsed-dark');
  const additionalSizes = [];
  if (process.argv.includes('--extended')) {
    for (const [width, height] of [[1440, 900], [1920, 1080], [700, 400]]) {
      const sizing = await application.evaluate(({ BrowserWindow, screen }, { width, height }) => {
        const w = BrowserWindow.getAllWindows()[0];
        const area = screen.getDisplayMatching(w.getBounds()).workAreaSize;
        const extra = { width: w.getBounds().width - w.getContentBounds().width, height: w.getBounds().height - w.getContentBounds().height };
        if (width + extra.width > area.width || height + extra.height > area.height) return { captured: false, reason: 'Display work area too small for an unclipped native capture', area };
        w.setContentSize(width, height);
        w.center();
        return { captured: w.getContentBounds().width === width && w.getContentBounds().height === height, area, actual: w.getContentBounds() };
      }, { width, height });
      additionalSizes.push({ width, height, ...sizing });
      if (sizing.captured) await screenshot(`viewport-${width}x${height}-dark`);
    }
  }
  const runtime = await application.evaluate(({ app, BrowserWindow, screen }) => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    contentBounds: BrowserWindow.getAllWindows()[0].getContentBounds(),
    windowBounds: BrowserWindow.getAllWindows()[0].getBounds(),
    zoomFactor: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    displayScale: screen.getPrimaryDisplay().scaleFactor,
  }));
  const archive = resolve(option('--executable', referenceConfig.executable), '../../Resources/app.asar');
  const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(destination, 'captures.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), tool: 'Playwright Electron 1.63.0',
    platform: platform(), architecture: arch(), kernel: release(), isolatedProfile: true,
    fixtureBaseUrl: baseUrl, archiveSha256, ...runtime, captures, additionalSizes,
    notes: ['Renderer screenshots exclude native macOS traffic lights.', 'Response duration, loading timer, and spinner phase are nondeterministic; mask only their regions for comparison.', 'DOM metrics are sampled immediately after PNG capture; live counters can differ by one tick.'],
  }, null, 2) + '\n');
  console.log(`Saved ${captures.length} screenshots and measured layouts; disposable profile: ${scratch}`);
} finally {
  // Close only the reference process created above; never close a user's session.
  if (application) {
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {});
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
