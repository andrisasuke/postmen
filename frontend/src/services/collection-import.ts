import { z } from "zod";
import { workspaceSchema } from "../types/data";
import { call, DataError } from "./data";

export const MAX_COLLECTION_BYTES = 10 * 1024 * 1024;
const previewSchema = z.object({
  token: z.string().uuid(),
  name: z.string().min(1),
  requestCount: z.number().int().nonnegative(),
  folderCount: z.number().int().nonnegative(),
  variableCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
const conflictSchema = z.object({
  id: z.string().uuid(), name: z.string(), requestCount: z.number().int().nonnegative(),
});
const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("conflict"), conflicts: z.array(conflictSchema).min(1) }),
  z.object({ status: z.literal("imported"), collectionId: z.string().uuid(), replacedId: z.string().uuid().nullable(), workspace: workspaceSchema }),
]);
export type ImportPreview = z.infer<typeof previewSchema>;
export type ImportConflict = z.infer<typeof conflictSchema>;
export type ImportOutcome = z.infer<typeof outcomeSchema>;
export type ImportedCollection = Extract<ImportOutcome, { status: "imported" }>;
export type ImportMode = "create" | "copy" | "overwrite";
export const collectionImport = {
  pick: () => call("pick_collection_import", {}, previewSchema.nullable()),
  async drop(file: File): Promise<ImportPreview> {
    if (!file.name.toLowerCase().endsWith(".json"))
      throw new DataError("INVALID_INPUT", "Choose a .json collection file.");
    if (file.size > MAX_COLLECTION_BYTES)
      throw new DataError("LIMIT_EXCEEDED", "Collection files are limited to 10 MiB.");
    // Transport only the dropped file. JSON parsing and validation belong to Rust.
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new DataError("INVALID_INPUT", "The dropped file could not be read as UTF-8 text."); }
    return call("preview_collection_import", { content }, previewSchema);
  },
  commit: (token: string, mode: ImportMode, targetId: string | null = null) =>
    call("commit_collection_import", { input: { token, mode, targetId } }, outcomeSchema),
  discard: (token: string) => call("discard_collection_import", { token }, z.null()),
};
