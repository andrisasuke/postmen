// Historical reference metadata lives with the private documentation archive.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = new URL("../../docs/reference-tooling.json", import.meta.url);
export const referenceConfig = JSON.parse(await readFile(path, "utf8").catch(error => {
  if (error.code === "ENOENT") throw new Error(`Restore the local docs link before running reference tooling: ${fileURLToPath(path)}`);
  throw error;
}));
