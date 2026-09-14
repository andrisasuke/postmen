// Unmasked full-image and region comparisons. Raster mismatch is reported,
// never promoted to "100% parity" via an arbitrary percent tolerance.
import assert from "node:assert/strict";
import { referenceConfig } from "./reference/config.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
const root = resolve("docs/milestones/M4"),
  reference = resolve(referenceConfig.directory);
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const gold = await read(resolve(reference, "captures.json")),
  repeated = await read(resolve(root, `${referenceConfig.repeatDirectory}/captures.json`));
const browser = await chromium.launch();
const page = await browser.newPage();
const imageCache = new Map();
async function image(path) {
  if (!imageCache.has(path))
    imageCache.set(
      path,
      `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
    );
  return imageCache.get(path);
}
async function diff(a, b, regions, artifacts) {
  const result = await page.evaluate(
    async ({ a, b, regions, artifacts }) => {
      const load = (src) =>
        new Promise((done, reject) => {
          const i = new Image();
          i.onload = () => done(i);
          i.onerror = reject;
          i.src = src;
        });
      const [first, second] = await Promise.all([load(a), load(b)]),
        w = first.width,
        h = first.height;
      if (w !== second.width || h !== second.height)
        return {
          incompatibleDimensions: true,
          first: [w, h],
          second: [second.width, second.height],
        };
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(first, 0, 0);
      const x = ctx.getImageData(0, 0, w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(second, 0, 0);
      const y = ctx.getImageData(0, 0, w, h);
      const delta = ctx.createImageData(w, h),
        stats = [];
      for (let i = 0; i < x.data.length; i += 4) {
        for (let c = 0; c < 3; c++)
          delta.data[i + c] = Math.min(
            255,
            Math.abs(x.data[i + c] - y.data[i + c]) * 4,
          );
        delta.data[i + 3] = 255;
      }
      for (const region of [
        { name: "whole-image", x: 0, y: 0, width: w, height: h },
        ...regions,
      ]) {
        let changed = 0,
          total = 0,
          sum = 0,
          maxChannelDelta = 0;
        const x0 = Math.max(0, Math.floor(region.x)),
          y0 = Math.max(0, Math.floor(region.y)),
          x1 = Math.min(w, Math.ceil(region.x + region.width)),
          y1 = Math.min(h, Math.ceil(region.y + region.height));
        for (let row = y0; row < y1; row++)
          for (let col = x0; col < x1; col++) {
            const i = (row * w + col) * 4;
            let differs = false;
            for (let c = 0; c < 4; c++) {
              const d = Math.abs(x.data[i + c] - y.data[i + c]);
              sum += d;
              maxChannelDelta = Math.max(maxChannelDelta, d);
              differs ||= d !== 0;
            }
            total++;
            if (differs) changed++;
          }
        stats.push({
          name: region.name,
          changedPixels: changed,
          totalPixels: total,
          changedPercent: total ? (changed / total) * 100 : 0,
          meanAbsoluteChannelDelta: total ? sum / (total * 4) : 0,
          maxChannelDelta,
        });
      }
      if (!artifacts) return { stats };
      ctx.putImageData(delta, 0, 0);
      const difference = canvas.toDataURL("image/png");
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(first, 0, 0);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(second, 0, 0);
      const overlay = canvas.toDataURL("image/png");
      return { stats, difference, overlay };
    },
    { a: await image(a), b: await image(b), regions, artifacts: !!artifacts },
  );
  if (artifacts && !result.incompatibleDimensions) {
    await mkdir(dirname(artifacts), { recursive: true });
    for (const kind of ["difference", "overlay"]) {
      await writeFile(
        `${artifacts}-${kind}.png`,
        Buffer.from(result[kind].split(",")[1], "base64"),
      );
      delete result[kind];
    }
  }
  return result;
}
const shell = [
  ".app-titlebar",
  ".status-bar",
  '[data-testid="sidebar"]',
  ".query-url-wrapper",
  '[data-testid="request-pane"]',
  '[data-testid="response-pane"]',
];
function regions(capture) {
  const measured = capture.elements
    .filter((e) => shell.includes(e.selector))
    .map((e) => ({ ...e, name: e.selector }));
  if (capture.name.startsWith("json-body-response")) {
    const editors = capture.elements.filter(
      (e) =>
        e.selector === ".cm-editor" ||
        (e.selector === ".CodeMirror" && e.font.includes("Fira")),
    );
    for (const [index, editor] of editors.slice(0, 2).entries())
      measured.push({
        ...editor,
        name: index ? "response-code-editor" : "request-code-editor",
      });
  }
  return measured.map((e) => ({
    name: e.name,
    x: e.x * 2,
    y: e.y * 2,
    width: e.width * 2,
    height: e.height * 2,
  }));
}
function geometry(ours, theirs) {
  const list = [];
  for (const selector of shell) {
    const a = ours.elements.find((e) => e.selector === selector),
      b = theirs.elements.find((e) => e.selector === selector);
    if (a && b) list.push({ region: selector, ours: a, reference: b });
  }
  if (ours.name.startsWith("json-body-response")) {
    const a = ours.elements.filter((e) => e.selector === ".cm-editor"),
      b = theirs.elements.filter(
        (e) => e.selector === ".CodeMirror" && e.font.includes("Fira"),
      );
    for (let i = 0; i < 2; i++)
      if (a[i] && b[i])
        list.push({
          region: i ? "response-code-editor" : "request-code-editor",
          ours: a[i],
          reference: b[i],
        });
  }
  return list.map(({ region, ours: a, reference: b }) => {
    const delta = Object.fromEntries(
      ["x", "y", "width", "height"].map((k) => [k, Math.abs(a[k] - b[k])]),
    );
    return {
      region,
      delta,
      withinOneCssPixel: Object.values(delta).every((x) => x <= 1),
      backgroundEqual: a.background === b.background,
    };
  });
}
try {
  const comparison = [],
    repeatability = [];
  for (const phase of ["before", "after"])
    for (const engine of ["chromium", "webkit"]) {
      const directory = resolve(root, phase, engine),
        ours = await read(resolve(directory, "captures.json"));
      for (const state of ours.captures) {
        const baseline = gold.captures.find((c) => c.name === state.name);
        if (!baseline) continue;
        const prefix =
          phase === "after"
            ? resolve(root, "comparison", engine, state.name)
            : null;
        comparison.push({
          phase,
          engine,
          name: state.name,
          nativeDesktop: false,
          geometry: geometry(state, baseline),
          raster: await diff(
            resolve(reference, baseline.file),
            resolve(directory, state.file),
            regions(baseline),
            prefix,
          ),
          artifacts: prefix
            ? `comparison/${engine}/${state.name}-{overlay,difference}.png`
            : null,
        });
      }
      if (phase === "after")
        for (const theme of ["light", "dark"]) {
          const a = ours.captures.find(
              (c) => c.name === `json-body-response-${theme}`,
            ),
            b = ours.captures.find((c) => c.name === a.name + "-repeat");
          repeatability.push({
            engine,
            theme,
            ...(await diff(
              resolve(directory, a.file),
              resolve(directory, b.file),
              regions(a),
              null,
            )),
          });
        }
    }
  const nativeDir = resolve(root, "native-visual"),
    native = await read(resolve(nativeDir, "captures.json"));
  for (const state of native.captures) {
    const baseline = gold.captures.find((c) => c.name === state.name);
    if (!baseline) continue;
    comparison.push({
      phase: "after",
      engine: "native-wkwebview",
      nativeDesktop: true,
      name: state.name,
      geometry: geometry(state, baseline),
      raster: await diff(
        resolve(reference, baseline.file),
        resolve(nativeDir, state.file),
        regions(baseline),
        resolve(root, "comparison/native", state.name),
      ),
      artifacts: `comparison/native/${state.name}-{overlay,difference}.png`,
    });
  }
  for (const theme of ["light", "dark"]) {
    for (const [engine, manifest, directory] of [
      ["Reference Electron", repeated, resolve(root, referenceConfig.repeatDirectory)],
      ["native-wkwebview", native, nativeDir],
    ]) {
      const a = manifest.captures.find(
          (c) => c.name === `json-body-response-${theme}`,
        ),
        b = manifest.captures.find((c) => c.name === a.name + "-repeat");
      repeatability.push({
        engine,
        theme,
        ...(await diff(
          resolve(directory, a.file),
          resolve(directory, b.file),
          regions(a),
          null,
        )),
      });
    }
  }
  const target = comparison.filter(
    (c) =>
      c.phase === "after" &&
      ["json-body-response-dark", "json-body-response-light"].includes(c.name),
  );
  const violations = target.flatMap((c) =>
    c.geometry
      .filter((g) => !g.withinOneCssPixel)
      .map((g) => ({ engine: c.engine, name: c.name, ...g })),
  );
  const allStates = comparison.filter((c) => c.phase === "after");
  const allStateViolations = allStates.flatMap((c) =>
    c.geometry
      .filter((g) => !g.withinOneCssPixel)
      .map((g) => ({ engine: c.engine, name: c.name, ...g })),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    reference: "Reference v4.1.0 pinned M0, not a new product baseline",
    masking:
      "None. Whole images and named regions include all identity, scope, timers and raster differences.",
    rasterMethod:
      "Decode both PNGs with the same Chromium canvas; exact RGBA equality. Difference PNG amplifies RGB deltas 4x for visibility. Percentages are diagnostic, not acceptance thresholds.",
    repeatability,
    geometryGate: {
      states: target.length,
      regions: target.reduce((n, c) => n + c.geometry.length, 0),
      toleranceCssPixels: 1,
      violations,
    },
    allStateGeometryGate: {
      states: allStates.length,
      regions: allStates.reduce((n, c) => n + c.geometry.length, 0),
      scope:
        "Measured outer shell/panes plus JSON editor bounds; not every control or glyph",
      toleranceCssPixels: 1,
      violations: allStateViolations,
    },
    comparison,
    fullProductParity: false,
  };
  await writeFile(
    resolve(root, "comparison.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        geometryGate: report.geometryGate,
        allStateGeometryGate: report.allStateGeometryGate,
        repeatability: repeatability.map((r) => ({
          engine: r.engine,
          theme: r.theme,
          wholeImage: r.stats?.[0],
        })),
        comparisons: comparison.length,
        fullProductParity: false,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    violations,
    [],
    "Implemented JSON editor/shell geometry differs from reference by >1 CSS px",
  );
  assert.deepEqual(
    allStateViolations,
    [],
    "Measured outer shell geometry differs by >1 CSS px",
  );
} finally {
  await browser.close();
}
