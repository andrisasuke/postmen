import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { collectionImport, MAX_COLLECTION_BYTES } from "./collection-import";
import { emptyWorkspace } from "../types/data";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const preview = () => ({ token: crypto.randomUUID(), name: "Sample", requestCount: 2, folderCount: 0, variableCount: 0, warnings: [] });
beforeEach(() => vi.mocked(invoke).mockReset());
it("opens the native picker without accepting a frontend path, and supports cancel", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await collectionImport.pick()).toBeNull();
  expect(invoke).toHaveBeenCalledWith("pick_collection_import", {});
  const result = preview(); vi.mocked(invoke).mockResolvedValueOnce(result);
  expect(await collectionImport.pick()).toEqual(result);
});
it("transports file text without parsing JSON in the frontend", async () => {
  const text = "not JSON; the backend must validate this";
  const file = Object.assign(new File([text], "collection.json"), {
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
  vi.mocked(invoke).mockResolvedValueOnce(preview());
  await collectionImport.drop(file);
  expect(invoke).toHaveBeenCalledWith("preview_collection_import", { content: text });
});
it("rejects non-JSON files, oversized files and invalid UTF-8 before IPC", async () => {
  await expect(collectionImport.drop(new File(["{}"], "file.txt"))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const large = new File([], "large.json"); Object.defineProperty(large, "size", { value: MAX_COLLECTION_BYTES + 1 });
  await expect(collectionImport.drop(large)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  const invalid = Object.assign(new File([], "invalid.json"), { arrayBuffer: async () => new Uint8Array([0xff]).buffer });
  await expect(collectionImport.drop(invalid)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(invoke).not.toHaveBeenCalled();
});
it("validates conflict/import responses and sends explicit overwrite targets", async () => {
  const token = crypto.randomUUID(), id = crypto.randomUUID();
  const conflict = { status: "conflict", conflicts: [{ id, name: "Sample", requestCount: 1 }] };
  vi.mocked(invoke).mockResolvedValueOnce(conflict);
  expect(await collectionImport.commit(token, "create")).toEqual(conflict);
  expect(invoke).toHaveBeenLastCalledWith("commit_collection_import", { input: { token, mode: "create", targetId: null } });
  const imported = { status: "imported", collectionId: id, replacedId: id, workspace: emptyWorkspace() };
  vi.mocked(invoke).mockResolvedValueOnce(imported);
  expect(await collectionImport.commit(token, "overwrite", id)).toEqual(imported);
  expect(invoke).toHaveBeenLastCalledWith("commit_collection_import", { input: { token, mode: "overwrite", targetId: id } });
  vi.mocked(invoke).mockResolvedValueOnce({ status: "imported" });
  await expect(collectionImport.commit(token, "copy")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("discards only the staged token and preserves safe backend errors", async () => {
  const token = crypto.randomUUID(); vi.mocked(invoke).mockResolvedValueOnce(null);
  await collectionImport.discard(token);
  expect(invoke).toHaveBeenLastCalledWith("discard_collection_import", { token });
  vi.mocked(invoke).mockRejectedValueOnce({ code: "IMPORT_EXPIRED", message: "Choose the file again." });
  await expect(collectionImport.commit(token, "copy")).rejects.toMatchObject({ code: "IMPORT_EXPIRED" });
});
