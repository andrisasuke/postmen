import { z } from "zod";
import { call } from "./data";
import { executionSchema, lastExecutionSchema } from "../types/execution";
import type { ExecutionApi } from "../types/execution";
const nothing = z.null().transform(() => undefined);
export const nativeExecutionApi: ExecutionApi = {
  prepare: (input) => call("prepare_execution", { input }, nothing),
  execute: (executionId) =>
    call("execute_request", { executionId }, executionSchema),
  getLastExecution: async (requestId) => {
    const snapshot = await call("get_last_execution", { requestId }, lastExecutionSchema.nullable());
    if (snapshot && snapshot.result.requestId !== requestId) throw new Error("Saved execution request ID does not match.");
    return snapshot;
  },
  cancel: (executionId) => call("cancel_request", { executionId }, nothing),
};
export const closeGuardReady = () => call("close_guard_ready", {}, nothing);
export const cancelQuit = () => call("cancel_quit", {}, nothing);
export const finishQuit = (discardWindowState = false) =>
  call("finish_quit", { discardWindowState }, nothing);
