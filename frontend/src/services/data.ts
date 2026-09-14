import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  attachmentSchema,
  collectionSchema,
  folderSchema,
  environmentSchema,
  environmentSelectionSchema,
  requestSchema,
  sessionSchema,
  workspaceSchema,
} from "../types/data";
import type { DataApi } from "../types/data";

export class DataError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof DataError) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "The operation could not be completed. Your draft was kept. Please retry.";
}
export async function call<T>(
  command: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await invoke<unknown>(command, args);
  } catch (error) {
    const parsed = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(error);
    throw parsed.success
      ? new DataError(parsed.data.code, parsed.data.message)
      : new DataError(
          "IPC_ERROR",
          "The desktop operation failed. Your draft was kept; retry or restart the application.",
        );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DataError(
      "INVALID_RESPONSE",
      "The desktop returned an incompatible data response. No local draft was overwritten.",
    );
  return parsed.data;
}
const nothing = z.null().transform(() => undefined);
export const nativeDataApi: DataApi = {
  loadWorkspace: () => call("load_workspace", {}, workspaceSchema),
  createCollection: (name) =>
    call("create_collection", { input: { name } }, collectionSchema),
  renameCollection: (id, name) =>
    call("rename_collection", { input: { id, name } }, collectionSchema),
  deleteCollection: (id) => call("delete_collection", { id }, nothing),
  createFolder: (input) => call("create_folder", { input }, folderSchema),
  updateFolder: (input) => call("update_folder", { input }, folderSchema),
  deleteFolder: (id) => call("delete_folder", { id }, nothing),
  createRequest: (input) => call("create_request", { input }, requestSchema),
  getRequest: (id) => call("get_request", { id }, requestSchema),
  saveRequest: (input) => call("save_request", { input }, requestSchema),
  deleteRequest: (id) => call("delete_request", { id }, nothing),
  reorderItems: (input) => call("reorder_items", { input }, nothing),
  saveEnvironment: (input) => call("save_environment", { input }, environmentSchema),
  deleteEnvironment: (id) => call("delete_environment", { id }, nothing),
  selectEnvironment: (input) => call("select_environment", { input }, environmentSelectionSchema),
  saveSession: (input) => call("save_session", { input }, sessionSchema),
  pickAttachment: () =>
    call("pick_attachment", {}, attachmentSchema.nullable()),
};
