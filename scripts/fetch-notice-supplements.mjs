// Upstream crates occasionally omit license files from their published tarballs.
// Recover repository notices at the exact .cargo_vcs_info commit, never HEAD.
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const cargo = JSON.parse(
  execFileSync(
    "rtk",
    [
      "proxy",
      "cargo",
      "metadata",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      "aarch64-apple-darwin",
    ],
    { encoding: "utf8", maxBuffer: 32e6 },
  ),
);
const report = JSON.parse(
  await readFile("docs/milestones/M4/dependency-notices.json", "utf8"),
);
const base = "docs/milestones/M4/notice-sources";
await mkdir(base, { recursive: true });
const cache = new Map();
let supplements = [];
try {
  ({ supplements } = JSON.parse(
    await readFile(`${base}/sources.json`, "utf8"),
  ));
  if (!Array.isArray(supplements))
    throw new Error("Invalid supplements manifest");
  for (const supplement of supplements) {
    for (const source of supplement.sources) {
      const bytes = await readFile(source.file);
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        throw new Error(`Notice supplement checksum mismatch: ${source.file}`);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // A missing source in an existing manifest must not silently erase evidence.
  if (supplements.length) throw error;
}
if (report.missing.length === 0) {
  console.log(
    `No missing notices; preserved ${supplements.length} pinned supplements`,
  );
  process.exit(0);
}
async function fetchPinned(url) {
  if (cache.has(url)) return cache.get(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const text = await response.text();
  const sha256 = createHash("sha256").update(text).digest("hex"),
    file = `${base}/${sha256}.txt`;
  await writeFile(file, text);
  const result = { url, file, sha256 };
  cache.set(url, result);
  return result;
}
for (const missing of report.missing) {
  const pkg = cargo.packages.find(
    (p) => p.name === missing.name && p.version === missing.version,
  );
  if (!pkg)
    throw new Error(
      `Locked crate not found: ${missing.name}@${missing.version}`,
    );
  const dir = dirname(pkg.manifest_path);
  const vcs = JSON.parse(
      await readFile(join(dir, ".cargo_vcs_info.json"), "utf8"),
    ),
    sha = vcs.git.sha1;
  const root = `https://raw.githubusercontent.com${new URL(pkg.repository).pathname.replace(/\/$/, "")}/${sha}/`;
  let paths = [],
    review = null;
  if (pkg.name === "alloc-stdlib") paths = ["LICENSE"];
  else if (pkg.name === "defmt-parser")
    paths = ["LICENSE-MIT", "LICENSE-APACHE"];
  else if (pkg.name === "tauri-plugin")
    paths = ["LICENSE_MIT", "LICENSE_APACHE-2.0"];
  else if (pkg.name.startsWith("unic-"))
    paths = ["COPYRIGHT.md", "LICENSE-MIT", "LICENSE-APACHE"];
  else if (pkg.name === "selectors") paths = ["selectors/lib.rs"];
  else {
    paths = ["LICENSE.md"];
    review =
      "Upstream publishes license declaration/context but no full standalone license text/copyright file at this revision; standard MIT terms supplied separately. Preserve upstream Apple-SDK note and review before public distribution.";
  }
  const sources = [];
  for (const path of paths) sources.push(await fetchPinned(root + path));
  if (pkg.name === "selectors") {
    const mpl = cargo.packages.find((p) => p.name === "cssparser");
    const file = join(dirname(mpl.manifest_path), "LICENSE");
    const text = await readFile(file, "utf8"),
      sha256 = createHash("sha256").update(text).digest("hex"),
      stored = `${base}/${sha256}.txt`;
    await writeFile(stored, text);
    sources.push({
      file: stored,
      sha256,
      source:
        "Unmodified MPL-2.0 standard terms from locked cssparser 0.36.0 LICENSE",
    });
  }
  if (review) {
    const full = await readFile("licenses/Vue-MIT.txt", "utf8");
    const text = full.slice(full.indexOf("Permission is hereby granted"));
    if (
      !text.startsWith("Permission is hereby granted") ||
      !text.includes("SOFTWARE")
    )
      throw new Error("No standard MIT terms found");
    const sha256 = createHash("sha256").update(text).digest("hex"),
      stored = `${base}/${sha256}.txt`;
    await writeFile(stored, text);
    sources.push({
      file: stored,
      sha256,
      source:
        "Standard MIT permission/warranty terms only; no copyright attribution invented",
    });
  }
  const supplement = {
    name: pkg.name,
    version: pkg.version,
    repository: pkg.repository,
    commit: sha,
    authors: pkg.authors,
    review,
    sources,
  };
  const existing = supplements.findIndex(
    (entry) => entry.name === pkg.name && entry.version === pkg.version,
  );
  if (existing < 0) supplements.push(supplement);
  else supplements[existing] = supplement;
}
await writeFile(
  `${base}/sources.json`,
  JSON.stringify({ supplements }, null, 2) + "\n",
);
console.log(`Recovered ${supplements.length} pinned upstream supplements`);
