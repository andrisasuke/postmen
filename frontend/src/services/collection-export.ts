import { z } from "zod";
import { call } from "./data";

const previewSchema = z.object({
  token: z.string().uuid(),
  files: z.array(z.object({
    id: z.string().uuid(), name: z.string(), fileName: z.string().min(1),
    requestCount: z.number().int().nonnegative(), warnings: z.array(z.string()),
  })).min(1).max(50),
});
const outcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("conflict"), files: z.array(z.string()).min(1) }),
  z.object({ status: z.literal("exported"), written: z.array(z.string().uuid()), failed: z.array(z.object({ id: z.string().uuid(), message: z.string() })) }),
]);
export type ExportPreview = z.infer<typeof previewSchema>;
export const collectionExport = {
  prepare: (collectionIds: string[], includeVariables: boolean) =>
    call("prepare_collection_export", { input: { collectionIds, includeVariables } }, previewSchema),
  pickDirectory: (token: string) => call("pick_collection_export_directory", { token }, z.string().nullable()),
  commit: (token: string, files: { id: string; name: string }[], overwrite = false) =>
    call("commit_collection_export", { input: { token, files, overwrite } }, outcomeSchema),
  discard: (token: string) => call("discard_collection_export", { token }, z.null()),
};
