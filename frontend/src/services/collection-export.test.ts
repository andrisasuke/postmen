import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { collectionExport } from "./collection-export";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());
it("prepares only selected saved collections and never transports database contents or file paths for writing", async () => {
  const id = crypto.randomUUID(); const token = crypto.randomUUID();
  const preview = { token, files: [{ id, name: "Collection", fileName: "Collection", requestCount: 0, warnings: [] }] };
  vi.mocked(invoke).mockResolvedValueOnce(preview);
  expect(await collectionExport.prepare([id],false)).toEqual(preview);
  expect(invoke).toHaveBeenLastCalledWith("prepare_collection_export", { input: { collectionIds: [id], includeVariables: false } });
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await collectionExport.pickDirectory(token)).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("pick_collection_export_directory", { token });
});
it("uses explicit overwrite consent and validates conflict/partial result contracts", async () => {
  const token = crypto.randomUUID(), id = crypto.randomUUID(); const files = [{ id, name: "Collection" }];
  vi.mocked(invoke).mockResolvedValueOnce({ status: "conflict", files: ["Collection.json"] });
  expect((await collectionExport.commit(token,files)).status).toBe("conflict");
  expect(invoke).toHaveBeenLastCalledWith("commit_collection_export", { input: { token, files, overwrite: false } });
  vi.mocked(invoke).mockResolvedValueOnce({ status: "exported", written: [id], failed: [] });
  expect((await collectionExport.commit(token,files,true)).status).toBe("exported");
  expect(invoke).toHaveBeenLastCalledWith("commit_collection_export", { input: { token, files, overwrite: true } });
  vi.mocked(invoke).mockResolvedValueOnce({ status: "exported" });
  await expect(collectionExport.commit(token,files)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
