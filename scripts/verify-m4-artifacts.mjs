// Read-only evidence/source checks; writes only the generated M4 audit report.
import assert from "node:assert/strict";
import { referenceConfig } from "./reference/config.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, access, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

const base = "docs/milestones/M4";
const output = resolve(base, "artifact-audit.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const checks = [];
const record = (name, detail) => checks.push({ name, passed: true, detail });
let pngCount = 0;
for (const file of [
  `${referenceConfig.directory}/captures.json`,
  ...[
    "before/chromium",
    "before/webkit",
    "after/chromium",
    "after/webkit",
    "native-visual",
    referenceConfig.repeatDirectory,
  ].map((directory) => `${base}/${directory}/captures.json`),
]) {
  const manifest = await json(file);
  for (const capture of manifest.captures) {
    const bytes = await readFile(resolve(dirname(file), capture.file));
    assert.equal(sha(bytes), capture.sha256, `${file}: ${capture.name} hash`);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      bytes.readUInt32BE(16),
      capture.viewport.width * capture.devicePixelRatio,
    );
    assert.equal(
      bytes.readUInt32BE(20),
      capture.viewport.height * capture.devicePixelRatio,
    );
    pngCount++;
  }
}
record("capture-manifests", {
  pngCount,
  checks: "SHA256, PNG signature, viewport × DPR dimensions",
});
const extraHover = [];
for (const engine of ["chromium", "webkit"]) {
  const file = `${base}/after/${engine}/hover-request-tab-dark.png`;
  const bytes = await readFile(file);
  assert.equal(bytes.readUInt32BE(16), 2880);
  assert.equal(bytes.readUInt32BE(20), 1680);
  extraHover.push({ file, sha256: sha(bytes) });
}
record("additional-hover-captures", extraHover);

const referenceRoot = referenceConfig.directory;
const sources = await json(`${referenceRoot}/sources.json`);
for (const source of sources.files)
  assert.equal(
    sha(await readFile(`${referenceRoot}/source/${source.path}`)),
    source.sha256,
    source.path,
  );
record("pinned-reference-sources", {
  commit: sources.commit,
  files: sources.files.length,
});

const dependency = await json(`${base}/dependency-notices.json`);
assert.equal(
  sha(await readFile("package-lock.json")),
  dependency.npmLockSha256,
);
assert.equal(
  sha(await readFile("src-tauri/Cargo.lock")),
  dependency.cargoLockSha256,
);
assert.deepEqual(dependency.missing, []);
const provenance = await json(`${base}/notice-sources/sources.json`);
for (const supplement of provenance.supplements)
  for (const source of supplement.sources)
    assert.equal(sha(await readFile(source.file)), source.sha256, source.file);
record("dependency-locks-and-supplements", {
  supplements: provenance.supplements.length,
  missing: [],
});

const release = await json(`${base}/release-bundle-smoke.json`);
assert.equal(release.passed, true);
assert.equal(sha(await readFile(release.executable)), release.sha256);
const resources = resolve(dirname(release.executable), "../Resources");
for (const file of release.bundledLicenses)
  assert.deepEqual(
    await readFile(join(resources, "licenses", file)),
    await readFile(join("licenses", file)),
  );
assert.deepEqual(
  await readFile(join(resources, "THIRD_PARTY_NOTICES.md")),
  await readFile("THIRD_PARTY_NOTICES.md"),
);
record("normal-bundle-hash-and-resources", {
  sha256: release.sha256,
  notices: release.bundledLicenses.length,
});

const verification = await json(`${base}/verification.json`);
assert.equal(verification.passed, true);
assert.ok(verification.checks.every((check) => check.code === 0));
const comparison = await json(`${base}/comparison.json`);
assert.deepEqual(comparison.geometryGate.violations, []);
assert.deepEqual(comparison.allStateGeometryGate.violations, []);
assert.equal(comparison.fullProductParity, false);
assert.ok(
  comparison.repeatability.every((pair) => pair.stats[0].changedPixels === 0),
);
const native = await json(`${base}/native-regression/runner.json`);
assert.equal(native.passed, true);
record("verification-reports", {
  automated: true,
  nativeTwoProcesses: true,
  fullProductParity: false,
});

// Evidence integrity is independent of application acceptance: preserve failures.
const osInput = await json(`${base}/os-input/results.json`);
assert.equal(osInput.evidenceValid, true);
// The pre-fix source hashes identify the historical failing implementation.
// They MUST NOT be rewritten to match the authorized OS-01–04 corrections.
for (const source of osInput.sources)
  assert.match(source.sha256, /^[a-f0-9]{64}$/, source.file);
for (const capture of osInput.screenshots) {
  const bytes = await readFile(`${base}/os-input/${capture.file}`);
  assert.equal(sha(bytes), capture.sha256, capture.file);
  assert.equal(bytes.readUInt32BE(16), capture.width);
  assert.equal(bytes.readUInt32BE(20), capture.height);
}
const osCounts = Object.fromEntries(
  ["passed", "failed", "blocked"].map((status) => [
    status, osInput.cases.filter((entry) => entry.status === status).length,
  ]),
);
assert.deepEqual(osInput.counts, osCounts);
assert.deepEqual(osCounts, { passed: 30, failed: 4, blocked: 2 });
assert.equal(osInput.passed, osCounts.failed === 0 && osCounts.blocked === 0);
record("os-input-evidence-not-acceptance", {
  screenshots: osInput.screenshots.length,
  counts: osCounts,
  applicationPassed: osInput.passed,
  sourceHashes: "Historical identity retained; current source checked against os-input-fixed below",
});

const fixedRoot = `${base}/os-input-fixed`;
const fixed = await json(`${fixedRoot}/results.json`);
assert.equal(fixed.evidenceValid, true);
// The later user-authorized titlebar spacing correction is NOT a native retest.
// Preserve the OS run's hashes; allow only this exact documented config delta.
const spacingLaunchers = new Set(["scripts/start-m4-os.mjs", "scripts/smoke-m3-native.mjs"]);
const spacingDeltas = [];
for (const source of fixed.sources) {
  const bytes = await readFile(source.file);
  if (sha(bytes) === source.sha256) continue;
  assert.ok(spacingLaunchers.has(source.file), `Unverified source change: ${source.file}`);
  const current = bytes.toString("utf8");
  const corrected = "trafficLightPosition:{x:12,y:20}";
  assert.equal(current.split(corrected).length, 2, source.file);
  const previous = current.replace(corrected, "trafficLightPosition:{x:12,y:10}");
  assert.equal(sha(previous), source.sha256, `Change exceeds spacing correction: ${source.file}`);
  spacingDeltas.push({ file: source.file, previousSha256: source.sha256, currentSha256: sha(bytes) });
}
for (const capture of fixed.screenshots) {
  const bytes = await readFile(`${fixedRoot}/${capture.file}`);
  assert.equal(sha(bytes), capture.sha256, capture.file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), capture.width);
  assert.equal(bytes.readUInt32BE(20), capture.height);
}
const fixedCounts = Object.fromEntries(
  ["passed", "failed", "blocked"].map((status) => [
    status, fixed.cases.filter((entry) => entry.status === status).length,
  ]),
);
assert.deepEqual(fixed.counts, fixedCounts);
assert.deepEqual(fixedCounts, { passed: 36, failed: 0, blocked: 2 });
assert.equal(fixed.passed, false, "Hardware-blocked cases remain open");
for (const prefix of ["OS-01-", "OS-02-", "OS-03-", "OS-04-"])
  assert.equal(fixed.cases.find((entry) => entry.id.startsWith(prefix))?.status, "passed");
const fixedChecks = await json(`${fixedRoot}/verification.json`);
assert.equal(fixedChecks.passed, true);
assert.ok(fixedChecks.checks.every((check) => check.code === 0));
const fixedNative = await json(`${fixedRoot}/native-regression/runner.json`);
assert.equal(fixedNative.passed, true);
assert.equal(fixedNative.reports.length, 2);
for (const phase of ["first", "restore"])
  assert.equal((await json(`${fixedRoot}/native-regression/${phase}/native-smoke.json`)).nativeDesktop, true);
const delta = await json(`${fixedRoot}/dependency-delta.json`);
assert.deepEqual(delta.added, []);
assert.deepEqual(delta.removed, []);
record("os-input-fixed-sources-and-historical-regression", {
  screenshots: fixed.screenshots.length,
  sources: fixed.sources.length,
  counts: fixedCounts,
  fourAuthorizedFixesPassed: true,
  fullAcceptance: false,
  nativeTwoProcesses: true,
  subsequentUntestedNativeSpacingDelta: spacingDeltas,
});
const spacingFiles = ["src-tauri/tauri.conf.json", "src-tauri/tauri.smoke.conf.json"];
for (const file of spacingFiles) {
  const main = (await json(file)).app.windows.find((window) => window.label === "main");
  assert.equal(main.titleBarStyle, "Overlay");
  assert.deepEqual(main.trafficLightPosition, { x: 12, y: 20 });
}
for (const file of [...spacingLaunchers, "scripts/smoke-m4-visual.mjs"]) {
  const content = await readFile(file, "utf8");
  const positions = [...content.matchAll(/trafficLightPosition\s*:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/g)];
  assert.equal(positions.length, 1, file);
  assert.deepEqual(positions[0].slice(1), ["12", "20"], file);
  spacingFiles.push(file);
}
record("titlebar-spacing-config-consistency-not-native-acceptance", {
  offset: { x: 12, y: 20 },
  nativeVisualAcceptance: "Pending user test; previous bundle/OS screenshots predate this change",
  sources: await Promise.all(spacingFiles.map(async (file) => ({ file, sha256: sha(await readFile(file)) }))),
});
const fixedBuild = await json(`${fixedRoot}/build.json`);
assert.equal(fixedBuild.code, 0);
const fixedRelease = await json(`${fixedRoot}/release-bundle-smoke.json`);
assert.equal(fixedRelease.passed, true);
assert.notEqual(fixedRelease.executable, release.executable);
const fixedBytes = await readFile(fixedRelease.executable);
assert.equal(sha(fixedBytes), fixedRelease.sha256);
assert.equal(fixedBytes.includes(Buffer.from("POSTMEN_SMOKE_MILESTONE")), false);
assert.equal(fixedBytes.includes(Buffer.from("POSTMEN_NATIVE_SMOKE_")), false);
const fixedResources = resolve(dirname(fixedRelease.executable), "../Resources");
assert.deepEqual(fixedRelease.bundledLicenses, release.bundledLicenses);
for (const file of fixedRelease.bundledLicenses)
  assert.deepEqual(await readFile(join(fixedResources, "licenses", file)), await readFile(join("licenses", file)));
assert.deepEqual(await readFile(join(fixedResources, "THIRD_PARTY_NOTICES.md")), await readFile("THIRD_PARTY_NOTICES.md"));
record("os-input-fixed-normal-bundle-hash-and-resources", {
  sha256: fixedRelease.sha256,
  notices: fixedRelease.bundledLicenses.length,
  previousBundlePreserved: true,
});

const legacy = spawnSync(
  "rtk",
  [
    "proxy",
    "rg",
    "-n",
    "-i",
    "dioxus|dragon.?ball|\\.postmen/postmen\\.db",
    "frontend/src",
    "src-tauri/src",
    "package.json",
    "package-lock.json",
    "frontend/package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ],
  { encoding: "utf8" },
);
assert.equal(
  legacy.status,
  1,
  `Unexpected legacy runtime reference or search error: ${legacy.stdout}${legacy.stderr}`,
);
for (const file of [
  "Cargo.toml",
  "Dioxus.toml",
  "src/app.rs",
  "run_macos.sh",
  "assets/icons/dragon-ball.svg",
  "assets/images/dragon-ball.png",
])
  assert.equal(
    await exists(file),
    false,
    `Legacy runtime file remains: ${file}`,
  );
record(
  "legacy-runtime-audit",
  "No active source/dependency/config references; legacy user DB was not opened by this audit",
);

const documents = [
  "README.md",
  "CLAUDE.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/UI_ACCEPTANCE_MATRIX.md",
  "docs/IPC_CONTRACT.md",
  `${base}/README.md`,
  `${base}/WORKLOG.md`,
  `${base}/os-input/README.md`,
  `${base}/os-input-fixed/README.md`,
  `${base}/titlebar-spacing.md`,
];
let links = 0;
for (const file of documents) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target));
    assert.ok(
      path === output || (await exists(path)),
      `${file}: missing link ${target}`,
    );
    links++;
  }
}
record("updated-document-links", { documents: documents.length, links });
let jsonFiles = 0;
async function verifyJson(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verifyJson(path);
    else if (entry.name.endsWith(".json") && resolve(path) !== output) {
      await json(path);
      jsonFiles++;
    }
  }
}
await verifyJson(base);
record("m4-json-validity", { jsonFiles });
const diff = spawnSync("rtk", ["proxy", "git", "diff", "--check"], {
  encoding: "utf8",
});
assert.equal(diff.status, 0, diff.stdout + diff.stderr);
record(
  "tracked-diff-whitespace",
  "git diff --check passed; no staging, commit or branch mutation",
);
await writeFile(
  output,
  JSON.stringify(
    { checkedAt: new Date().toISOString(), passed: true, checks },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    { passed: true, pngCount, checks: checks.map((check) => check.name) },
    null,
    2,
  ),
);
